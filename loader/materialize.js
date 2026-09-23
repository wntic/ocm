import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, rmdirSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { setSkillsPath } from "./config.js"
import { discoverPlugins, PLUGIN_NAME_RE } from "./discovery.js"
import { gcComponents, renderedComponentOwned, removeLegacyContainers } from "./gc.js"
import { pluginRefusal, refusalOutcomes } from "./gate.js"
import { linkComponents } from "./link-components.js"
import { gcTargets, isRenderedFile } from "./links.js"
import { foldedComponentGroups, foldedDirPairs } from "./limits.js"
import { pluginGateFindings } from "./manifest-gate.js"
import { syncMcp } from "./mcp.js"
import { DISPLACED_DIR, LINKS_DIR, OPENCODE_AGENTS_DIR, OPENCODE_COMMANDS_DIR, OPENCODE_PLUGINS_DIR } from "./paths.js"
import { readRegistry, isRecord } from "./registry.js"
import { refusalAliases } from "./renames.js"
import { approvedComponents } from "./trust.js"

function managedDirs(dir, registry) {
  const dirs = [dir]
  for (const entry of Object.values(registry.marketplaces ?? {})) {
    if (entry && typeof entry.dir === "string" && entry.dir && entry.dir !== dir) dirs.push(entry.dir)
  }
  return dirs.sort((a, b) => b.length - a.length)
}

function gitRevision(dir) {
  try {
    const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, timeout: 5000, encoding: "utf8" })
    if (result.status === 0) return result.stdout.trim()
  } catch {
    // a failed git spawn reads as no revision — "unknown" below
  }
  return "unknown"
}

// brief 41: the tokens substituted at materialization time — the suffix is
// the same normalization pluginRootEnv uses for the shell.env hook. The
// full literal including `}` is the token, so a per-marketplace form never
// matches the flat one
function rootTokensFor(name) {
  const suffix = name.replaceAll("-", "_").toUpperCase()
  return [
    "${OCM_PLUGIN_ROOT}",
    "${CLAUDE_PLUGIN_ROOT}",
    "${OCM_PLUGIN_ROOT_" + suffix + "}",
    "${CLAUDE_PLUGIN_ROOT_" + suffix + "}",
  ]
}

function buildCtx(name, dir, registry, entry, warnings, options) {
  return {
    name,
    dir,
    managed: managedDirs(dir, registry),
    revision: (entry && typeof entry.revision === "string" && entry.revision) || gitRevision(dir),
    warnings,
    force: options.force === true,
    displacedDir: join(DISPLACED_DIR, new Date().toISOString().replace(/[:.]/g, "-")),
    // brief 31 §6: dest → displaced cache target for every takeover this
    // run, so an outcome can state where the user's file went
    displacements: new Map(),
    // brief 45 §3: dests takeOver declined this run — the partial-install signal
    withheld: new Set(),
  }
}

function buildState(name, dir, options, warnings, outcomes) {
  const registry = readRegistry()
  const entry = (registry.marketplaces ?? {})[name]
  const aliases = refusalAliases(entry)
  if (options.aliases) for (const [to, from] of options.aliases) aliases.set(to, from)
  return {
    name,
    dir,
    warnings,
    outcomes,
    entry,
    approved: approvedComponents(dir, entry),
    ctx: buildCtx(name, dir, registry, entry, warnings, options),
    enabled: options.enabled ?? null,
    // an internal single-plugin scope: setEnabled's --force takeover tears
    // down only the incumbent's yielded plugin; every other plugin's links
    // and mcp keys stay untouched
    only: options.plugin ?? null,
    // brief 31 §2: source paths that changed in this pass; a current outcome
    // for one of them is reported as refreshed
    changed: options.changed ?? null,
    // brief 31 §5 / brief 40: discovered name → kept name for a refused
    // rename; the whole run — dests, desired sets, outcomes — sees the kept
    // name. The registry's recorded refusals are the source of truth, so a
    // caller with no rename knowledge keeps the plugin under its old name
    aliases,
    rootTokens: rootTokensFor(name),
    skillsDir: join(LINKS_DIR, name, "skills"),
    desiredCommands: new Set(),
    desiredAgents: new Set(),
    desiredMirrors: new Set(),
    desiredPluginLinks: new Set(),
    // the setSkillsPath decision keeps today's meaning: desired skills whose
    // render succeeded, not the shim's derived counts.skill — a skill skipped
    // by an unowned dest must still keep the skills path registered
    skillsRendered: 0,
    refused: new Set(),
  }
}

// the `only` filter matches discovered names; the alias then renames the
// plugin to the name its record kept, so every dest and outcome below
// uses it
function resolveActive(st) {
  const discovered = discoverPlugins(st.dir)
  // brief 28 §3.3: a folded directory pair is refused here as reconcile
  // refuses it — a plugin whose record the update dropped must not keep
  // its links (F128)
  st.foldedDirs = new Map(
    foldedDirPairs(discovered.map((plugin) => basename(plugin.dir))).flatMap((pair) => pair.map((dirName) => [dirName, pair])),
  )
  st.active = (st.only === null ? discovered : discovered.filter((plugin) => plugin.name === st.only))
    .map((plugin) => (st.aliases.has(plugin.name) ? { ...plugin, name: st.aliases.get(plugin.name) } : plugin))
}

function gatePlugin(st, plugin) {
  if (st.enabled !== null && !st.enabled.has(plugin.name)) return null
  if (!PLUGIN_NAME_RE.test(plugin.name)) {
    st.warnings.push(`skipped plugin "${plugin.name}": name must match ${PLUGIN_NAME_RE}`)
    return null
  }
  // brief 28 §3.3: both members of a folded directory pair are skipped,
  // never grandfathered — the same refusal reconcile applies to the
  // record, so the dropped plugin's links and mcp keys go too
  const foldedPair = st.foldedDirs.get(basename(plugin.dir))
  if (foldedPair) {
    st.refused.add(plugin.name)
    const reason = `plugins/${foldedPair[0]} and plugins/${foldedPair[1]} differ only in case — plugin "${plugin.name}" skipped; ask the author to rename one and update again`
    st.outcomes.push(...refusalOutcomes(plugin, reason, st.skillsDir))
    st.warnings.push(reason)
    return null
  }
  // brief 31 §4: a plugin the registry refuses is a plugin the
  // materializer refuses — one skipped outcome per component, no links.
  // A registered plugin is exempt from the manifest check (brief 29), as
  // is a direct call with no registry entry to grandfather against; the
  // limit never grandfathers
  const grandfathered = st.enabled === null || st.entry === undefined || plugin.name in (st.entry.plugins ?? {})
  const refusal = pluginRefusal(st.dir, plugin, grandfathered)
  if (refusal) {
    st.refused.add(plugin.name)
    const refusalSkips = refusalOutcomes(plugin, refusal.message, st.skillsDir)
    st.outcomes.push(...refusalSkips)
    for (const outcome of refusalSkips) st.warnings.push(refusal.message)
    return null
  }
  return foldedComponents(st, plugin)
}

// brief 28 §4: two component names that fold to one link name cannot
// both be served — the first in discovery order is kept, the sibling
// skipped before it can reach a desired set and silently replace it
function foldedComponents(st, plugin) {
  const folded = new Set()
  for (const group of foldedComponentGroups(plugin.components)) {
    for (const name of group.names.slice(1)) {
      folded.add(`${group.type}/${name}`)
      st.warnings.push(`skipped ${plugin.name}:${name}: differs from ${group.names[0]} only in case — rename one in the marketplace`)
    }
  }
  return folded
}

// a refused plugin keeps its mcp prefix (stale keys are removed) but its
// keys are never written
function syncMcpAndSkills(st) {
  const mcpEnabled = st.refused.size === 0
    ? st.enabled
    : new Set([...(st.enabled ?? st.active.map((plugin) => plugin.name))].filter((name) => !st.refused.has(name)))
  st.outcomes.push(...syncMcp(st.active, st.dir, st.entry, mcpEnabled, st.approved, st.warnings, st.name))

  // a scoped pass never unregisters the skills path: other plugins'
  // rendered skills may still live there
  if (st.only === null || st.skillsRendered > 0) {
    const skills = setSkillsPath(st.skillsDir, st.skillsRendered > 0)
    if (skills.state === "skipped" || skills.state === "failed") st.warnings.push(skills.reason)
  }
}

export function materialize(name, dir, options = {}) {
  const warnings = []
  const outcomes = []
  const report = () => ({ marketplace: name, outcomes, warnings })

  removeLegacyContainers(name)

  if (!existsSync(dir)) {
    warnings.push(`marketplace "${name}" directory missing (${dir}), links left untouched`)
    return report()
  }

  const st = buildState(name, dir, options, warnings, outcomes)

  mkdirSync(OPENCODE_COMMANDS_DIR, { recursive: true })
  mkdirSync(OPENCODE_AGENTS_DIR, { recursive: true })
  mkdirSync(OPENCODE_PLUGINS_DIR, { recursive: true })

  resolveActive(st)
  for (const plugin of st.active) {
    const folded = gatePlugin(st, plugin)
    if (folded !== null) linkComponents(st, plugin, folded)
  }

  gcComponents(st)
  syncMcpAndSkills(st)

  return report()
}

// the enabled set a caller drives materialize with: registry plugins that
// are not disabled, plus discovered-but-unregistered ones in auto mode
export function enabledPlugins(entry, dir) {
  if (!entry || typeof entry.dir !== "string" || !entry.dir) return null
  const registered = entry.plugins ?? {}
  const enabled = new Set()
  for (const [name, plugin] of Object.entries(registered)) {
    if (plugin && plugin.enabled !== false) enabled.add(name)
  }
  if (entry.mode !== "explicit") {
    // a name some marketplace already provides is never auto-installed
    // here: it would displace the incumbent's links (spec 04)
    const taken = new Set()
    for (const other of Object.values(readRegistry().marketplaces ?? {})) {
      if (isRecord(other?.plugins)) for (const name of Object.keys(other.plugins)) taken.add(name)
    }
    const discovered = discoverPlugins(dir)
    // brief 28 §3.3: a folded directory pair is never auto-installed —
    // reconcile drops its record and the materializer refuses its links
    const folded = new Set(foldedDirPairs(discovered.map((plugin) => basename(plugin.dir))).flat())
    for (const plugin of discovered) {
      if (plugin.name in registered || taken.has(plugin.name)) continue
      if (folded.has(basename(plugin.dir))) continue
      // brief 29: a plugin the manifest gate refuses is never auto-installed;
      // registered ones are grandfathered via the registry branch above
      if (pluginGateFindings(dir, plugin).length > 0) continue
      enabled.add(plugin.name)
    }
  }
  return enabled
}

// spec 05 teardown: every owned link goes, and one removed outcome per entry
// records what went — brief 31 §6 derives the restart notice from them
export function removeLinksFor(name, marketplaceDir) {
  removeLegacyContainers(name)
  const warnings = []
  const outcomes = []
  const ctx = { name, dir: marketplaceDir, managed: [], revision: null, warnings }
  // the record is still on disk here: removeMarketplace deletes it only
  // after this teardown, and it is the scope proof for rendered commands
  // and agents in the shared dirs
  const entry = (readRegistry().marketplaces ?? {})[name]
  const removedOutcome = (type, plugin, component, dest) => {
    outcomes.push({ type, plugin, component, source: null, dest, state: "removed", reason: null })
  }
  const ownedCommand = renderedComponentOwned(entry, "command")
  const ownedAgent = renderedComponentOwned(entry, "agent")
  for (const entry of gcTargets(OPENCODE_COMMANDS_DIR, new Set(), ctx, ownedCommand)) {
    const split = entry.indexOf(":")
    removedOutcome("command", entry.slice(0, split), entry.slice(split + 1), join(OPENCODE_COMMANDS_DIR, entry))
  }
  for (const entry of gcTargets(OPENCODE_AGENTS_DIR, new Set(), ctx, ownedAgent)) {
    const split = entry.indexOf(":")
    removedOutcome("agent", entry.slice(0, split), entry.slice(split + 1), join(OPENCODE_AGENTS_DIR, entry))
  }
  for (const entry of gcTargets(OPENCODE_PLUGINS_DIR, new Set(), ctx)) {
    const stripped = entry.slice("ocm--".length)
    const split = stripped.indexOf("--")
    removedOutcome("plugin", stripped.slice(0, split), stripped.slice(split + 2), join(OPENCODE_PLUGINS_DIR, entry))
  }
  const skillsDir = join(LINKS_DIR, name, "skills")
  for (const entry of gcTargets(skillsDir, new Set(), ctx, (path) => isRenderedFile(join(path, "SKILL.md")))) {
    const split = entry.indexOf("--")
    removedOutcome("skill", entry.slice(0, split), entry.slice(split + 2), join(skillsDir, entry))
  }
  // prune the cache dirs only when nothing unowned is left in them
  try {
    rmdirSync(skillsDir)
    rmdirSync(dirname(skillsDir))
  } catch {
    // a non-empty dir is kept — the refused rmdir is what leaves it
  }
  return { marketplace: name, outcomes, warnings }
}
