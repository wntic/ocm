import { rmSync } from "node:fs"
import { join, relative } from "node:path"
import { writeJsonAtomic } from "./atomic.js"
import { setSkillsPath } from "./config.js"
import { collisionError, incumbentMarketplace } from "./collisions.js"
import { restoreDisplaced } from "./displaced.js"
import { git } from "./git.js"
import { discoverMarketplace, discoveryError, readManifest } from "./manifest.js"
import { enabledPlugins, materialize, removeLinksFor } from "./materialize.js"
import { limitRefusal, manifestRefusal } from "./limits.js"
import { removeMcpKeys } from "./mcp.js"
import { DISPLACED_RECORD_FILE, LINKS_DIR } from "./paths.js"
import { loadRegistryForWrite, saveRegistry } from "./registry.js"
import { manifestName, normaliseMarketplaceName, parseSource, placeClone } from "./source.js"
import { denyEntry, executableComponents, grantEntry } from "./trust.js"

// discovery roots at the subdir when the source was a tree url; git
// operations keep running against the clone root (spec 05)
export function componentRoot(entry) {
  return entry.subdir ? join(entry.dir, entry.subdir) : entry.dir
}

export function registerPlugins(registry, name, plugins) {
  // every caller assigns or verifies the entry in the registry right before this
  const entry = registry.marketplaces[name]
  const root = componentRoot(entry)
  const updated = {}
  for (const plugin of plugins) {
    const existing = entry.plugins[plugin.name]
    const incumbent = incumbentMarketplace(registry, name, plugin.name)
    // an explicit install survives update: the user took the name over,
    // and update reports the collision rather than undoing the choice
    const chosen = existing?.enabled && existing.installedAt !== null
    // a colliding name registers disabled; a collision that has cleared
    // registers as if fresh — enabled in auto, and in explicit only when
    // the user installed it while it was colliding. A collision record
    // was never chosen, so installedAt stays null (spec 02)
    let enabled = existing?.collision
      ? entry.mode === "auto" || existing.installedAt !== null
      : existing?.enabled ?? (entry.mode !== "explicit" && plugin.manifest.defaultEnabled !== false)
    if (incumbent && !chosen) enabled = false
    const record = {
      source: relative(root, plugin.dir),
      components: plugin.components,
      enabled,
      // the materialization time, not the marketplace's addedAt: a plugin
      // that arrived via update's auto-install is not backdated (spec 25)
      installedAt: existing?.installedAt ?? (incumbent || entry.mode === "explicit" || !enabled ? null : new Date().toISOString()),
      version: plugin.manifest.version ?? null,
      manifest: plugin.manifest,
    }
    if (incumbent && !chosen) record.collision = incumbent
    updated[plugin.name] = record
  }
  entry.plugins = updated
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
  const { name, dir, head } = parsed.isGit
    ? await placeClone(parsed, wanted, ref, registry, options.name !== undefined)
    : { name: wanted, dir: parsed.url, head: "" }
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
  const refusal = discoveryError(plugins) ?? limitRefusal(plugins) ?? manifestRefusal(name, plugins)
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
    revision: head || null,
    syncIntervalMs: null,
    trust: { code: "none" },
    lastSync: head ? { at: new Date().toISOString(), ok: true, error: null } : null,
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
  // spec 21: the restore pass runs after the links come down, so a displaced
  // original returns to its path only when nothing now holds it. Spec 27 §3:
  // a consumed record is pruned so a later teardown stops re-reporting it
  const { lines: restore, resolved } = restoreDisplaced({ marketplace: name })
  if (resolved) writeJsonAtomic(DISPLACED_RECORD_FILE, `${JSON.stringify(resolved, null, 2)}\n`)
  const skillsWarning = setSkillsPath(join(LINKS_DIR, name, "skills"), false)
  if (skillsWarning) warnings.push(skillsWarning)
  // collision records never materialized, so their mcp keys are not ours to
  // drop; a disabled record's keys came down when it was disabled — after a
  // spec 18 takeover they belong to the name's new owner, not to us
  const owned = Object.entries(entry.plugins).filter(([, plugin]) => !plugin.collision)
  const mcpWarning = removeMcpKeys(owned.filter(([, plugin]) => plugin.enabled !== false).map(([pluginName]) => pluginName))
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
    restore,
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
