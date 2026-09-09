import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { OCM_REGISTRY_FILE, normaliseMarketplaceName } from "../paths"
import { loadRegistryForWrite, saveRegistry } from "../registry"
import { componentRoot, incumbentMarketplace, materializeLinks, registerPlugins, removeLinks, removeMcpKeys } from "../install"
import { pullRepo } from "../../loader/core.js"
import { discoverMarketplace, readManifest } from "../discovery"
import { manifestName, parseSource, placeClone } from "../source"
import type { ParsedSource } from "../source"
import type { DiscoveredPlugin } from "../discovery"
import type { MarketplaceEntry, Registry } from "../types"
import { installLoader } from "../loader"

export function reportWarnings(warnings: string[]): void {
  for (const warning of warnings) console.error(`  warning: ${warning}`)
}

export function reportRestart(changed: number): void {
  if (changed > 0) console.log("restart opencode to activate")
}

export function reportUpgrade(wasV1: boolean): void {
  if (wasV1) console.log(`registry upgraded v1 → v2 (${OCM_REGISTRY_FILE})`)
}

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
}

// a failed add leaves no clone behind; a local directory is the user's
function discardClone(parsed: ParsedSource, dir: string): void {
  if (parsed.isGit) rmSync(dir, { recursive: true, force: true })
}

export function add(source: string, options: AddOptions = {}): void {
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
  const plugins = [...discoverMarketplace(root).values()]
  if (!plugins.length) {
    discardClone(parsed, dir)
    throw new Error(
      `no plugins found in ${parsed.url}\n` +
        `  expected plugins/<name>/{commands,agents,skills}/ at the repository root\n` +
        `  run \`ocm scan ${parsed.url}\` to see what was found`,
    )
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
  const links = materializeLinks(name, entry)
  reportWarnings(links.warnings)
  reportRestart(links.created)
  installLoader()
  saveRegistry(registry)
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
    console.log(`  ${pluginName}: ${parts.join(", ")} removed`)
  }
}

export async function update(name?: string): Promise<void> {
  const { registry, wasV1 } = loadRegistryForWrite()
  const names = name ? [name] : Object.keys(registry.marketplaces)
  if (!names.length) {
    console.log("no marketplaces added yet (ocm add <url|path>)")
    return
  }
  let reinstalledLoader = false
  for (const marketplaceName of names) {
    const entry = registry.marketplaces[marketplaceName]
    if (!entry) {
      console.error(`marketplace "${marketplaceName}" not found, skipping`)
      continue
    }
    if (!existsSync(entry.dir)) {
      console.error(`marketplace "${marketplaceName}" directory missing (${entry.dir}), skipping`)
      continue
    }
    if (entry.local === false) {
      console.log(`updating ${marketplaceName}...`)
      const result = await pullRepo(entry.dir)
      if (!result.ok) {
        console.error(`  failed: ${result.output}`)
        continue
      }
      console.log(`  ${result.changed ? "updated to new revision" : "already up to date"}`)
    } else {
      console.log(`${marketplaceName} is local (${entry.url}), refreshing links`)
    }
    const plugins = [...discoverMarketplace(componentRoot(entry)).values()]
    registerPlugins(registry, marketplaceName, plugins)
    const links = materializeLinks(marketplaceName, entry)
    reportWarnings(links.warnings)
    reportRestart(links.created)
    if (!reinstalledLoader) {
      installLoader()
      reinstalledLoader = true
    }
  }
  saveRegistry(registry)
  reportUpgrade(wasV1)
}
