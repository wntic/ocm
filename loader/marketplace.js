import { rmSync } from "node:fs"
import { join, relative } from "node:path"
import { setSkillsPath } from "./config.js"
import { discoverMarketplace, discoveryError, readManifest } from "./manifest.js"
import { enabledPlugins, materialize, removeLinksFor } from "./materialize.js"
import { removeMcpKeys } from "./mcp.js"
import { LINKS_DIR } from "./paths.js"
import { loadRegistryForWrite, saveRegistry } from "./registry.js"
import { manifestName, normaliseMarketplaceName, parseSource, placeClone } from "./source.js"
import { git } from "./sync.js"
import { denyEntry, executableComponents, grantEntry } from "./trust.js"

// discovery roots at the subdir when the source was a tree url; git
// operations keep running against the clone root (spec 05)
export function componentRoot(entry) {
  return entry.subdir ? join(entry.dir, entry.subdir) : entry.dir
}

// plugin names are globally unique across marketplaces (spec 04, axis 4):
// the first marketplace to provide a name is the incumbent
export function incumbentMarketplace(registry, self, pluginName) {
  for (const [name, entry] of Object.entries(registry.marketplaces)) {
    if (name !== self && entry.plugins[pluginName]) return name
  }
}

export function registerPlugins(registry, name, plugins) {
  // every caller assigns or verifies the entry in the registry right before this
  const entry = registry.marketplaces[name]
  const root = componentRoot(entry)
  const updated = {}
  for (const plugin of plugins) {
    const existing = entry.plugins[plugin.name]
    const incumbent = incumbentMarketplace(registry, name, plugin.name)
    // a colliding name registers disabled; a collision that has cleared
    // registers as if fresh — enabled in auto, and in explicit only when
    // the user installed it while it was colliding. A collision record
    // was never chosen, so installedAt stays null (spec 02)
    let enabled = existing?.collision
      ? entry.mode === "auto" || existing.installedAt !== null
      : existing?.enabled ?? (entry.mode !== "explicit" && plugin.manifest.defaultEnabled !== false)
    if (incumbent) enabled = false
    const record = {
      source: relative(root, plugin.dir),
      components: plugin.components,
      enabled,
      installedAt: existing?.installedAt ?? (incumbent || entry.mode === "explicit" || !enabled ? null : entry.addedAt),
      version: plugin.manifest.version ?? null,
      manifest: plugin.manifest,
    }
    if (incumbent) record.collision = incumbent
    updated[plugin.name] = record
  }
  entry.plugins = updated
}

// spec 04, axis 4: plugin names are globally unique across marketplaces;
// adding a marketplace that ships a taken name fails with both sources named
function collisionError(registry, name, plugins) {
  for (const plugin of plugins) {
    const incumbent = incumbentMarketplace(registry, name, plugin.name)
    if (incumbent) {
      return `plugin "${plugin.name}" is already provided by marketplace "${incumbent}"; not adding "${name}". Remove one, or ask its author to rename.`
    }
  }
  return null
}

// a failed add leaves no clone behind (a local directory is the user's);
// the discovery warnings ride the error so a refusal cannot swallow them
function addRefusal(message, warnings, parsed, dir) {
  if (parsed.isGit) rmSync(dir, { recursive: true, force: true })
  const error = new Error(message)
  error.warnings = warnings
  throw error
}

// spec 05 add, minus the dialog: register, decide trust from the flag, save,
// materialize. With no flag the trust stays "none" and the executable
// components ship blocked, named in trustComponents for the prompt to render.
export async function addMarketplace(source, options = {}) {
  const parsed = parseSource(source)
  const { registry, wasV1 } = loadRegistryForWrite()
  const mode = options.explicit ? "explicit" : "auto"
  const ref = options.ref ?? parsed.ref
  const fallback = parsed.isGit ? parsed.name : manifestName(readManifest(parsed.url).name) ?? parsed.name
  const wanted = options.name ? normaliseMarketplaceName(options.name) : fallback
  if (registry.marketplaces[wanted]) {
    throw new Error(`marketplace "${wanted}" already added (use "ocm update ${wanted}")`)
  }
  const { name, dir } = parsed.isGit
    ? await placeClone(parsed, wanted, ref, registry, options.name !== undefined)
    : { name: wanted, dir: parsed.url }
  const root = parsed.subdir ? join(dir, parsed.subdir) : dir
  const discovered = discoverMarketplace(root)
  const plugins = [...discovered.plugins.values()]
  if (!plugins.length) {
    addRefusal(
      `no plugins found in ${parsed.url}\n` +
        `  expected plugins/<name>/{commands,agents,skills}/ at the repository root\n` +
        `  run \`ocm scan ${parsed.url}\` to see what was found`,
      discovered.warnings, parsed, dir,
    )
  }
  const refusal = discoveryError(plugins)
  if (refusal) addRefusal(refusal, discovered.warnings, parsed, dir)
  const collision = collisionError(registry, name, plugins)
  if (collision) addRefusal(collision, discovered.warnings, parsed, dir)
  const entry = {
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
  const trustComponents = executableComponents(root, entry)
  if (typeof options.trust === "boolean" && trustComponents.length) {
    if (options.trust) grantEntry(entry, trustComponents)
    else denyEntry(entry)
  }
  // the materializer reads the registry from disk, so the trust decision
  // must be saved before links are made (spec 07)
  saveRegistry(registry)
  const report = materialize(name, root, { enabled: enabledPlugins(entry, root) })
  return {
    name,
    url: parsed.url,
    dir,
    root,
    mode,
    plugins: plugins.map((plugin) => ({ name: plugin.name, components: plugin.components })),
    warnings: discovered.warnings,
    report,
    trustComponents,
    wasV1,
  }
}

// spec 05 remove: full teardown — links, skills.paths entry, ocm-- mcp keys,
// the clone (never a local directory), the registry record
export function removeMarketplace(name) {
  const { registry, wasV1 } = loadRegistryForWrite()
  const entry = registry.marketplaces[name]
  if (!entry) {
    throw new Error(`marketplace "${name}" not found (ocm list)`)
  }
  const warnings = []
  removeLinksFor(name, entry.dir)
  const skillsWarning = setSkillsPath(join(LINKS_DIR, name, "skills"), false)
  if (skillsWarning) warnings.push(skillsWarning)
  // collision records never materialized, so their mcp keys are not ours to drop
  const owned = Object.entries(entry.plugins).filter(([, plugin]) => !plugin.collision)
  const mcpWarning = removeMcpKeys(owned.map(([pluginName]) => pluginName))
  if (mcpWarning) warnings.push(mcpWarning)
  // `local === false` rather than `!local`: an entry missing the field must
  // never be treated as ocm-managed and deleted
  if (entry.local === false) {
    rmSync(entry.dir, { recursive: true, force: true })
  }
  delete registry.marketplaces[name]
  saveRegistry(registry)
  return {
    name,
    owned: owned.map(([pluginName, plugin]) => ({ name: pluginName, components: plugin.components })),
    warnings,
    wasV1,
  }
}

// spec 08: pinning is branch- and tag-following, never commit-freezing.
// The ref is validated by fetching it before it is saved, so a typo fails
// immediately rather than breaking the next unattended sync. A null ref
// clears the pin.
export async function pinMarketplace(name, ref) {
  const { registry, wasV1 } = loadRegistryForWrite()
  const entry = registry.marketplaces[name]
  if (!entry) throw new Error(`marketplace "${name}" not found (ocm list)`)
  if (entry.local) throw new Error(`marketplace "${name}" is local; nothing to pin`)
  if (ref === null) {
    entry.ref = null
    saveRegistry(registry)
    return { name, ref: null, cleared: true, wasV1 }
  }
  if (!ref) throw new Error(`missing ref (ocm pin <name> <ref>)`)
  const fetch = await git(["fetch", "--depth", "1", "origin", ref], entry.dir)
  if (!fetch.ok) throw new Error(`cannot pin "${name}" to "${ref}": ${fetch.stderr || fetch.stdout}`)
  entry.ref = ref
  saveRegistry(registry)
  return { name, ref, cleared: false, wasV1 }
}
