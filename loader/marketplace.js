import { rmSync } from "node:fs"
import { join, relative } from "node:path"
import { writeJsonAtomic } from "./atomic.js"
import { setSkillsPath } from "./config.js"
import { collisionError, incumbentMarketplace } from "./collisions.js"
import { discoverPlugins, manifestOnlyMessages } from "./discovery.js"
import { restoreDisplaced } from "./displaced.js"
import { pluginHashes } from "./digest.js"
import { git, treePluginFiles } from "./git.js"
import { marketplaceGateFindings } from "./manifest-gate.js"
import { discoverMarketplace, discoveryError, readManifest } from "./manifest.js"
import { enabledPlugins, materialize, removeLinksFor } from "./materialize.js"
import { caseFoldRefusal, limitRefusal, treeFoldRefusal } from "./limits.js"
import { removeMcpKeys } from "./mcp.js"
import { DISPLACED_RECORD_FILE, LINKS_DIR } from "./paths.js"
import { loadRegistryForWrite, saveRegistry, saveRegistryIfChanged } from "./registry.js"
import { duplicateRefusal, manifestName, normaliseMarketplaceName, parseSource, placeClone } from "./source.js"
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
    // brief 30 §3: a local marketplace's changed-set baseline; a git
    // entry's is its revision pair
    if (entry.local) record.hashes = pluginHashes(plugin)
    updated[plugin.name] = record
  }
  entry.plugins = updated
}

// brief 31 §3: the registry's component list is the outcome record filtered
// to created|current|refreshed, per plugin — a component no outcome supports
// is not stored. A plugin with no outcome this run keeps its stored
// components: only a mutation rewrites records (brief 31 §8).
export function deriveComponents(registry, name, outcomes) {
  const entry = registry.marketplaces?.[name]
  if (!entry) return
  const byPlugin = new Map()
  for (const outcome of outcomes ?? []) {
    if (!byPlugin.has(outcome.plugin)) byPlugin.set(outcome.plugin, [])
    byPlugin.get(outcome.plugin).push(outcome)
  }
  for (const [pluginName, pluginOutcomes] of byPlugin) {
    const record = entry.plugins[pluginName]
    if (!record) continue
    const components = {}
    for (const type of ["command", "agent", "skill", "plugin", "mcp"]) {
      const names = [
        ...new Set(
          pluginOutcomes
            .filter((o) => o.type === type && (o.state === "created" || o.state === "current" || o.state === "refreshed"))
            .map((o) => o.component),
        ),
      ].sort()
      if (names.length) components[type] = names
    }
    record.components = components
  }
}

// a failed add leaves no clone behind (a local directory is the user's);
// the discovery warnings ride the error so a refusal cannot swallow them
function addRefusal(message, warnings, parsed, dir) {
  if (parsed.isGit) rmSync(dir, { recursive: true, force: true })
  const error = new Error(message)
  error.warnings = warnings
  throw error
}

// brief 29: the gate's findings as add's refusal — one indented line per
// finding, capped at 10, then the fix
function gateRefusal(name, findings) {
  if (!findings.length) return null
  const lines = findings.slice(0, 10).map((finding) => `  ${finding.message}`)
  if (findings.length > 10) lines.push(`  … and ${findings.length - 10} more`)
  return `marketplace "${name}" is not installable — ${findings.length} manifest finding${findings.length === 1 ? "" : "s"}\n${lines.join("\n")}\n  each needs at least { "description": "…" }; see ocm validate and the README`
}

// brief 29 §2: add's refusal chain as one function, so ocm scan runs exactly
// what add runs and its exit code predicts the real run's — first refusal
// wins, in add's order. `dir` is the clone root; discovery roots at the
// subdir when the source was a tree url
export async function addRefusalChain(name, parsed, dir, head, plugins, registry) {
  const root = parsed.subdir ? join(dir, parsed.subdir) : dir
  // brief 28 §3: the local check fires where both directories really exist;
  // the tree check catches a pair a case-insensitive checkout has collapsed
  return discoveryError(plugins) ?? caseFoldRefusal(name, discoverPlugins(root)) ??
    (parsed.isGit ? treeFoldRefusal(name, head, (await treePluginFiles(dir, head, parsed.subdir)) ?? []) : null) ??
    limitRefusal(plugins) ?? gateRefusal(name, marketplaceGateFindings(root, plugins)) ??
    collisionError(registry, name, plugins)
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
  const duplicate = duplicateRefusal(registry, parsed, wanted)
  if (duplicate) throw new Error(duplicate)
  const { name, dir, head } = parsed.isGit ? await placeClone(parsed, wanted, ref, registry, options.name !== undefined)
    : { name: wanted, dir: parsed.url, head: "" }
  const root = parsed.subdir ? join(dir, parsed.subdir) : dir
  const discovered = discoverMarketplace(root)
  const plugins = [...discovered.plugins.values()]
  if (!plugins.length) {
    // brief 39 §4: name the manifest-only directories the bare refusal hid
    const manifestOnly = manifestOnlyMessages(root).map((message) => `  ${message}`)
    addRefusal(
      `no plugins found in ${parsed.url}\n` +
        (manifestOnly.length ? `${manifestOnly.join("\n")}\n` : "") +
        `  expected plugins/<name>/{commands,agents,skills}/ at the repository root\n` +
        `  run \`ocm scan ${parsed.url}\` to see what was found`,
      discovered.warnings, parsed, dir,
    )
  }
  const refusal = await addRefusalChain(name, parsed, dir, head, plugins, registry)
  if (refusal) addRefusal(refusal, discovered.warnings, parsed, dir)
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
  // brief 31 §3: the records are derived from what materialized, then saved
  // again — a derivation that changed nothing writes nothing
  deriveComponents(registry, name, report.outcomes)
  saveRegistryIfChanged(registry)
  return {
    name,
    url: parsed.url,
    dir,
    root,
    mode,
    plugins: plugins.map((plugin) => ({ name: plugin.name, components: plugin.components })),
    // brief 32 §6 (F223): a broken plugin beside a valid one is the author's
    // defect — a warning on a successful add, not a failed add
    warnings: [...discovered.warnings, ...manifestOnlyMessages(root)],
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
  const links = removeLinksFor(name, entry.dir)
  warnings.push(...links.warnings)
  // spec 21: the restore pass runs after the links come down, so a displaced
  // original returns to its path only when nothing now holds it. Spec 27 §3:
  // a consumed record is pruned so a later teardown stops re-reporting it
  const { lines: restore, resolved } = restoreDisplaced({ marketplace: name })
  if (resolved) writeJsonAtomic(DISPLACED_RECORD_FILE, `${JSON.stringify(resolved, null, 2)}\n`)
  const skills = setSkillsPath(join(LINKS_DIR, name, "skills"), false)
  if (skills.state === "skipped" || skills.state === "failed") warnings.push(skills.reason)
  // collision records never materialized, so their mcp keys are not ours to
  // drop; a disabled record's keys came down when it was disabled — after a
  // spec 18 takeover they belong to the name's new owner, not to us
  const owned = Object.entries(entry.plugins).filter(([, plugin]) => !plugin.collision)
  const mcp = removeMcpKeys(owned.filter(([, plugin]) => plugin.enabled !== false).map(([pluginName]) => pluginName))
  if (mcp.warning) warnings.push(mcp.warning)
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
    report: { marketplace: name, outcomes: [...links.outcomes, ...mcp.outcomes], warnings },
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
