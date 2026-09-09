import { rmSync } from "node:fs"
import { join } from "node:path"
import { normaliseMarketplaceName } from "../paths"
import { loadRegistryForWrite, saveRegistry } from "../registry"
import { incumbentMarketplace, materializeLinks, registerPlugins, removeLinks, removeMcpKeys } from "../install"
import { discoverMarketplace, discoveryError, readManifest } from "../discovery"
import { manifestName, parseSource, placeClone } from "../source"
import type { ParsedSource } from "../source"
import type { DiscoveredPlugin } from "../discovery"
import type { MarketplaceEntry, Registry } from "../types"
import { git } from "../git"
import { installLoader } from "../loader"
import { reportRestart, reportUpgrade, reportWarnings } from "../report"
import { decideTrust } from "./trust"

// spec 04, axis 4: plugin names are globally unique across marketplaces;
// adding a marketplace that ships a taken name fails with both sources named
function collisionError(registry: Registry, name: string, plugins: DiscoveredPlugin[]): string | null {
  for (const plugin of plugins) {
    const incumbent = incumbentMarketplace(registry, name, plugin.name)
    if (incumbent) {
      return `plugin "${plugin.name}" is already provided by marketplace "${incumbent}"; not adding "${name}". Remove one, or ask its author to rename.`
    }
  }
  return null
}

export interface AddOptions {
  explicit?: boolean
  name?: string
  ref?: string
  trust?: boolean
}

// a failed add leaves no clone behind; a local directory is the user's
function discardClone(parsed: ParsedSource, dir: string): void {
  if (parsed.isGit) rmSync(dir, { recursive: true, force: true })
}

export async function add(source: string, options: AddOptions = {}): Promise<void> {
  const parsed = parseSource(source)
  const { registry, wasV1 } = loadRegistryForWrite()
  const mode: "auto" | "explicit" = options.explicit ? "explicit" : "auto"
  const ref = options.ref ?? parsed.ref
  const fallback = parsed.isGit ? parsed.name : manifestName(readManifest(parsed.url).name) ?? parsed.name
  const wanted = options.name ? normaliseMarketplaceName(options.name) : fallback
  if (registry.marketplaces[wanted]) {
    throw new Error(`marketplace "${wanted}" already added (use "ocm update ${wanted}")`)
  }
  const { name, dir } = parsed.isGit
    ? placeClone(parsed, wanted, ref, registry, options.name !== undefined)
    : { name: wanted, dir: parsed.url }
  const root = parsed.subdir ? join(dir, parsed.subdir) : dir
  const discovered = discoverMarketplace(root)
  const plugins = [...discovered.plugins.values()]
  if (!plugins.length) {
    discardClone(parsed, dir)
    throw new Error(
      `no plugins found in ${parsed.url}\n` +
        `  expected plugins/<name>/{commands,agents,skills}/ at the repository root\n` +
        `  run \`ocm scan ${parsed.url}\` to see what was found`,
    )
  }
  reportWarnings(discovered.warnings)
  const refusal = discoveryError(plugins)
  if (refusal) {
    discardClone(parsed, dir)
    throw new Error(refusal)
  }
  const collision = collisionError(registry, name, plugins)
  if (collision) {
    discardClone(parsed, dir)
    throw new Error(collision)
  }
  const entry: MarketplaceEntry = {
    url: parsed.url,
    dir,
    local: !parsed.isGit,
    addedAt: new Date().toISOString(),
    mode,
    ref: parsed.isGit ? ref : null,
    subdir: parsed.subdir,
    revision: null,
    syncIntervalMs: null,
    trust: { code: "none" },
    lastSync: null,
    plugins: {},
  }
  registry.marketplaces[name] = entry
  registerPlugins(registry, name, plugins)
  await decideTrust(name, entry, root, options.trust)
  // the materializer reads the registry from disk, so the trust decision
  // must be saved before links are made (spec 07)
  saveRegistry(registry)
  const links = materializeLinks(name, entry)
  reportWarnings(links.warnings)
  reportRestart(links.created)
  installLoader()
  reportUpgrade(wasV1)
  reportAdded(name, plugins, mode)
}

function reportAdded(name: string, plugins: DiscoveredPlugin[], mode: "auto" | "explicit"): void {
  console.log(`added marketplace "${name}"`)
  for (const plugin of plugins) {
    const parts: string[] = []
    if (plugin.components.agent) parts.push(`${plugin.components.agent.length} agents`)
    if (plugin.components.command) parts.push(`${plugin.components.command.length} commands`)
    if (plugin.components.skill) parts.push(`${plugin.components.skill.length} skills`)
    if (plugin.components.plugin) parts.push(`${plugin.components.plugin.length} plugins`)
    if (plugin.components.mcp) parts.push(`${plugin.components.mcp.length} mcp servers`)
    const available = mode === "explicit" ? " — available, not installed" : ""
    console.log(`  ${plugin.name} (${parts.join(", ")})${available}`)
  }
  console.log("commands and agents are available as /<plugin>:<name> in every project")
}

export function remove(name: string): void {
  const { registry, wasV1 } = loadRegistryForWrite()
  const entry = registry.marketplaces[name]
  if (!entry) {
    throw new Error(`marketplace "${name}" not found (ocm list)`)
  }
  removeLinks(name, entry.dir)
  // collision records never materialized, so their mcp keys are not ours to drop
  const owned = Object.entries(entry.plugins).filter(([, plugin]) => !plugin.collision)
  removeMcpKeys(owned.map(([pluginName]) => pluginName))
  // `local === false` rather than `!local`: an entry missing the field must
  // never be treated as ocm-managed and deleted
  if (entry.local === false) {
    rmSync(entry.dir, { recursive: true, force: true })
  }
  delete registry.marketplaces[name]
  saveRegistry(registry)
  reportUpgrade(wasV1)
  console.log(`removed marketplace "${name}"`)
  for (const [pluginName, plugin] of owned) {
    const parts: string[] = []
    if (plugin.components.agent) parts.push(`${plugin.components.agent.length} agents`)
    if (plugin.components.command) parts.push(`${plugin.components.command.length} commands`)
    if (plugin.components.skill) parts.push(`${plugin.components.skill.length} skills`)
    if (plugin.components.plugin) parts.push(`${plugin.components.plugin.length} plugins`)
    if (plugin.components.mcp) parts.push(`${plugin.components.mcp.length} mcp servers`)
    console.log(`  ${pluginName}: ${parts.join(", ")} removed`)
  }
}

// spec 08: pinning is branch- and tag-following, never commit-freezing.
// The ref is validated by fetching it before it is saved, so a typo fails
// immediately rather than breaking the next unattended sync.
export function pin(name: string, ref?: string, clear = false): void {
  const { registry, wasV1 } = loadRegistryForWrite()
  const entry = registry.marketplaces[name]
  if (!entry) throw new Error(`marketplace "${name}" not found (ocm list)`)
  if (entry.local) throw new Error(`marketplace "${name}" is local; nothing to pin`)
  if (clear) {
    entry.ref = null
    saveRegistry(registry)
    reportUpgrade(wasV1)
    console.log(`marketplace "${name}" unpinned (following the default branch)`)
    return
  }
  if (!ref) throw new Error(`missing ref (ocm pin <name> <ref>)`)
  const fetch = git(["fetch", "--depth", "1", "origin", ref], entry.dir)
  if (!fetch.ok) throw new Error(`cannot pin "${name}" to "${ref}": ${fetch.stderr || fetch.stdout}`)
  entry.ref = ref
  saveRegistry(registry)
  reportUpgrade(wasV1)
  console.log(`marketplace "${name}" pinned to ${ref}`)
}
