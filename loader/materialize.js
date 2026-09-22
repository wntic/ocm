import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, rmdirSync } from "node:fs"
import { basename, dirname, join, relative } from "node:path"
import { setSkillsPath } from "./config.js"
import { discoverPlugins, PLUGIN_NAME_RE } from "./discovery.js"
import { gcTargets, isRenderedFile, link, mirror, render } from "./links.js"
import { pluginRefusal, refusalOutcomes } from "./gate.js"
import { foldedComponentGroups } from "./limits.js"
import { pluginGateFindings } from "./manifest-gate.js"
import { syncMcp } from "./mcp.js"
import { LINKS_DIR, DISPLACED_DIR, OPENCODE_AGENTS_DIR, OPENCODE_COMMANDS_DIR, OPENCODE_PLUGINS_DIR } from "./paths.js"
import { readRegistry, isRecord } from "./registry.js"
import { refusalAliases } from "./renames.js"
import { approvedComponents, componentKey } from "./trust.js"

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
  } catch {}
  return "unknown"
}

// `commands` and `command` are both opencode-valid; a name resolvable in
// both is a clash we refuse rather than guess
function resolveSource(pluginDir, dirs, name, ctx, plugin) {
  const found = dirs.map((d) => join(pluginDir, d, name)).filter((p) => existsSync(p))
  if (found.length > 1) {
    ctx.warnings.push(`skipped ${plugin}:${name}: found in both ${dirs[0]} and ${dirs[1]}`)
    return undefined
  }
  return found[0]
}

// the single transform: `name: <value>` becomes `name: "<plugin>:<value>"`;
// everything else in the file is preserved byte-for-byte
function renderSkillMd(content, plugin) {
  if (!content.startsWith("---\n")) return null
  const close = content.indexOf("\n---\n", 3)
  if (close === -1) return null
  const frontmatter = content.slice(4, close)
  const match = frontmatter.match(/^name:[^\n]*/m)
  if (!match) return null
  const value = match[0].slice(5).trim().replace(/^["']|["']$/g, "")
  if (!value) return null
  const renamed = `name: "${plugin}:${value}"`
  const updated = frontmatter.slice(0, match.index) + renamed + frontmatter.slice(match.index + match[0].length)
  return content.slice(0, 4) + updated + content.slice(close)
}

function removeLegacyContainers(name) {
  rmSync(join(OPENCODE_COMMANDS_DIR, `ocm--${name}`), { recursive: true, force: true })
  rmSync(join(OPENCODE_AGENTS_DIR, `ocm--${name}`), { recursive: true, force: true })
}

// brief 41: a rendered command or agent is ours by its marker, but the
// commands and agents dirs are shared between marketplaces and the marker
// cannot say which one rendered it — the registry record claiming the
// plugin and the component is the scope, as a symlink's target is for links
function renderedComponentOwned(entry, type) {
  return (path) => {
    if (!isRenderedFile(path)) return false
    const name = basename(path)
    const split = name.indexOf(":")
    const record = entry?.plugins?.[name.slice(0, split)]
    return Boolean(record && !record.collision && (record.components?.[type] ?? []).includes(name.slice(split + 1)))
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

  const registry = readRegistry()
  const entry = (registry.marketplaces ?? {})[name]
  const approved = approvedComponents(dir, entry)
  const revision = (entry && typeof entry.revision === "string" && entry.revision) || gitRevision(dir)
  const ctx = {
    name,
    dir,
    managed: managedDirs(dir, registry),
    revision,
    warnings,
    force: options.force === true,
    displacedDir: join(DISPLACED_DIR, new Date().toISOString().replace(/[:.]/g, "-")),
    // brief 31 §6: dest → displaced cache target for every takeover this
    // run, so an outcome can state where the user's file went
    displacements: new Map(),
  }
  const enabled = options.enabled ?? null
  // an internal single-plugin scope: setEnabled's --force takeover tears
  // down only the incumbent's yielded plugin; every other plugin's links
  // and mcp keys stay untouched
  const only = options.plugin ?? null
  // brief 31 §2: source paths that changed in this pass; a current outcome
  // for one of them is reported as refreshed
  const changed = options.changed ?? null
  // brief 31 §5 / brief 40: discovered name → kept name for a refused
  // rename; the whole run — dests, desired sets, outcomes — sees the kept
  // name. The registry's recorded refusals are the source of truth, so a
  // caller with no rename knowledge keeps the plugin under its old name
  const aliases = refusalAliases(entry)
  if (options.aliases) for (const [to, from] of options.aliases) aliases.set(to, from)
  // brief 41: the tokens substituted at materialization time — the suffix is
  // the same normalization pluginRootEnv uses for the shell.env hook. The
  // full literal including `}` is the token, so a per-marketplace form never
  // matches the flat one
  const suffix = name.replaceAll("-", "_").toUpperCase()
  const rootTokens = [
    "${OCM_PLUGIN_ROOT}",
    "${CLAUDE_PLUGIN_ROOT}",
    "${OCM_PLUGIN_ROOT_" + suffix + "}",
    "${CLAUDE_PLUGIN_ROOT_" + suffix + "}",
  ]
  const skillsDir = join(LINKS_DIR, name, "skills")
  const desiredCommands = new Set()
  const desiredAgents = new Set()
  const desiredMirrors = new Set()
  const desiredPluginLinks = new Set()

  // one outcome per linked component; a skipped or refused link carries the
  // warning link() pushed for it as its reason
  const linkOutcome = (type, plugin, component, source, dest, status, warnStart) => {
    let state = status === "ok" ? "current" : status
    if (state === "current" && changed !== null && changed.has(relative(dir, source))) state = "refreshed"
    let reason = null
    if (state === "skipped" || state === "refused") {
      reason = ctx.warnings.length > warnStart ? ctx.warnings[ctx.warnings.length - 1] : null
    }
    const outcome = { type, plugin, component, source, dest, state, reason }
    if (ctx.displacements.has(dest)) outcome.displaced = ctx.displacements.get(dest)
    outcomes.push(outcome)
  }

  const removedOutcome = (type, plugin, component, dest) => {
    outcomes.push({ type, plugin, component, source: null, dest, state: "removed", reason: null })
  }

  // brief 41: a body referencing a plugin-root variable renders with this
  // marketplace's root substituted — the variable never reaches opencode's
  // template engine, so a symlink would be broken exactly where it is used.
  // Returns null when the body has no token, so the caller keeps link().
  const renderRooted = (source, dest, plugin) => {
    let body
    try {
      body = readFileSync(source, "utf8")
    } catch {}
    if (!body || !rootTokens.some((token) => body.includes(token))) return null
    let existing
    try {
      existing = readlinkSync(dest)
    } catch {}
    // the symlink→rendered transition: dest is unambiguously ours by the
    // same proof link() uses for "ok", so remove it — render() would
    // otherwise displace it as unowned
    if (existing === source) rmSync(dest, { force: true })
    const owned = isRenderedFile(dest)
    let text = body
    for (const token of rootTokens) text = text.replaceAll(token, dir)
    const status = render(source, dest, () => text, ctx, plugin)
    // an update to an existing rendered file is a refresh (current or
    // refreshed via the changed set), never a creation
    return status === "created" && owned ? "ok" : status
  }

  mkdirSync(OPENCODE_COMMANDS_DIR, { recursive: true })
  mkdirSync(OPENCODE_AGENTS_DIR, { recursive: true })
  mkdirSync(OPENCODE_PLUGINS_DIR, { recursive: true })

  const discovered = discoverPlugins(dir)
  // the `only` filter matches discovered names; the alias then renames the
  // plugin to the name its record kept, so every dest and outcome below
  // uses it
  const active = (only === null ? discovered : discovered.filter((plugin) => plugin.name === only))
    .map((plugin) => (aliases.has(plugin.name) ? { ...plugin, name: aliases.get(plugin.name) } : plugin))
  // the setSkillsPath decision keeps today's meaning: desired skills whose
  // render succeeded, not the shim's derived counts.skill — a skill skipped
  // by an unowned dest must still keep the skills path registered
  let skillsRendered = 0
  const refused = new Set()
  for (const plugin of active) {
    if (enabled !== null && !enabled.has(plugin.name)) continue
    if (!PLUGIN_NAME_RE.test(plugin.name)) {
      warnings.push(`skipped plugin "${plugin.name}": name must match ${PLUGIN_NAME_RE}`)
      continue
    }
    // brief 31 §4: a plugin the registry refuses is a plugin the
    // materializer refuses — one skipped outcome per component, no links.
    // A registered plugin is exempt from the manifest check (brief 29), as
    // is a direct call with no registry entry to grandfather against; the
    // limit never grandfathers
    const grandfathered = enabled === null || entry === undefined || plugin.name in (entry.plugins ?? {})
    const refusal = pluginRefusal(dir, plugin, grandfathered)
    if (refusal) {
      refused.add(plugin.name)
      const refusalSkips = refusalOutcomes(plugin, refusal.message, skillsDir)
      outcomes.push(...refusalSkips)
      for (const outcome of refusalSkips) warnings.push(refusal.message)
      continue
    }
    // brief 28 §4: two component names that fold to one link name cannot
    // both be served — the first in discovery order is kept, the sibling
    // skipped before it can reach a desired set and silently replace it
    const folded = new Set()
    for (const group of foldedComponentGroups(plugin.components)) {
      for (const name of group.names.slice(1)) {
        folded.add(`${group.type}/${name}`)
        warnings.push(`skipped ${plugin.name}:${name}: differs from ${group.names[0]} only in case — rename one in the marketplace`)
      }
    }
    for (const file of plugin.components.command ?? []) {
      if (folded.has(`command/${file}`)) continue
      const source = resolveSource(plugin.dir, ["commands", "command"], file, ctx, plugin.name)
      if (!source) continue
      const dest = join(OPENCODE_COMMANDS_DIR, `${plugin.name}:${file}`)
      desiredCommands.add(`${plugin.name}:${file}`)
      const warnStart = ctx.warnings.length
      const status = renderRooted(source, dest, plugin.name) ?? link(source, dest, ctx, plugin.name, file)
      linkOutcome("command", plugin.name, file, source, dest, status, warnStart)
    }
    for (const file of plugin.components.agent ?? []) {
      if (folded.has(`agent/${file}`)) continue
      const source = resolveSource(plugin.dir, ["agents", "agent"], file, ctx, plugin.name)
      if (!source) continue
      const dest = join(OPENCODE_AGENTS_DIR, `${plugin.name}:${file}`)
      desiredAgents.add(`${plugin.name}:${file}`)
      const warnStart = ctx.warnings.length
      const status = renderRooted(source, dest, plugin.name) ?? link(source, dest, ctx, plugin.name, file)
      linkOutcome("agent", plugin.name, file, source, dest, status, warnStart)
    }
    for (const rel of plugin.components.skill ?? []) {
      if (folded.has(`skill/${rel}`)) continue
      const sourceDir = resolveSource(plugin.dir, ["skills", "skill"], rel, ctx, plugin.name)
      if (!sourceDir) continue
      const skillMd = join(sourceDir, "SKILL.md")
      let transformed = null
      try {
        transformed = renderSkillMd(readFileSync(skillMd, "utf8"), plugin.name)
      } catch {}
      const mirrorName = `${plugin.name}--${rel.split("/").join("-")}`
      const mirrorDir = join(skillsDir, mirrorName)
      if (transformed === null) {
        const reason = `skipped ${skillMd}: no name in frontmatter`
        warnings.push(reason)
        // brief 31 §4: the skip is an outcome, not only a warning — it
        // leaves the registry and the report in the same commit
        outcomes.push({ type: "skill", plugin: plugin.name, component: rel, source: sourceDir, dest: mirrorDir, state: "skipped", reason })
        continue
      }
      skillsRendered += 1
      desiredMirrors.add(mirrorName)
      const warnStart = ctx.warnings.length
      const mirrored = mirror(sourceDir, mirrorDir, { "SKILL.md": () => transformed }, ctx, plugin.name, rel)
      let state
      let reason = null
      if (mirrored.status === "skipped") {
        state = "skipped"
        reason = ctx.warnings.length > warnStart ? ctx.warnings[ctx.warnings.length - 1] : null
      } else if (mirrored.created > 0) {
        // a sibling link or the render wrote something: the restart notice
        // fires exactly when today's mirror.created did
        state = "created"
      } else {
        state = "current"
      }
      if (state === "current" && changed !== null && changed.has(relative(dir, sourceDir))) state = "refreshed"
      const outcome = { type: "skill", plugin: plugin.name, component: rel, source: sourceDir, dest: mirrorDir, state, reason }
      // a takeover inside the mirror records the mirror's child, not the
      // mirror itself — any displacement under it belongs to this outcome
      for (const [displacedDest, target] of ctx.displacements) {
        if (displacedDest.startsWith(`${mirrorDir}/`)) outcome.displaced = target
      }
      outcomes.push(outcome)
      for (const entry of mirrored.removed) {
        removedOutcome("skill", plugin.name, `${rel}/${entry}`, join(mirrorDir, entry))
      }
    }
    for (const file of plugin.components.plugin ?? []) {
      if (folded.has(`plugin/${file}`)) continue
      const source = resolveSource(plugin.dir, ["plugin", "plugins"], file, ctx, plugin.name)
      if (!source) continue
      const dest = join(OPENCODE_PLUGINS_DIR, `ocm--${plugin.name}--${file}`)
      if (!approved.get(componentKey("plugin", plugin.name, file))) {
        const reason = `blocked (untrusted): ${plugin.name}:${file} not linked — run \`ocm trust ${name}\` to approve`
        warnings.push(reason)
        outcomes.push({ type: "plugin", plugin: plugin.name, component: file, source, dest, state: "blocked", reason })
        continue
      }
      desiredPluginLinks.add(`ocm--${plugin.name}--${file}`)
      const warnStart = ctx.warnings.length
      const status = link(source, dest, ctx, plugin.name, file)
      linkOutcome("plugin", plugin.name, file, source, dest, status, warnStart)
    }
  }

  // plugin names cannot contain ":", "--" or uppercase (PLUGIN_NAME_RE),
  // so a name prefix never spans another plugin's entries
  const scope = only === null ? undefined : `${only}:`
  // built before the gc loops: their `entry` loop variable shadows the
  // registry entry inside the loop head, where the argument would be a TDZ
  // reference
  const ownedCommand = renderedComponentOwned(entry, "command")
  const ownedAgent = renderedComponentOwned(entry, "agent")
  for (const entry of gcTargets(OPENCODE_COMMANDS_DIR, desiredCommands, ctx, ownedCommand, scope)) {
    const split = entry.indexOf(":")
    removedOutcome("command", entry.slice(0, split), entry.slice(split + 1), join(OPENCODE_COMMANDS_DIR, entry))
  }
  for (const entry of gcTargets(OPENCODE_AGENTS_DIR, desiredAgents, ctx, ownedAgent, scope)) {
    const split = entry.indexOf(":")
    removedOutcome("agent", entry.slice(0, split), entry.slice(split + 1), join(OPENCODE_AGENTS_DIR, entry))
  }
  for (const entry of gcTargets(skillsDir, desiredMirrors, ctx, (path) => isRenderedFile(join(path, "SKILL.md")), only === null ? undefined : `${only}--`)) {
    const split = entry.indexOf("--")
    removedOutcome("skill", entry.slice(0, split), entry.slice(split + 2), join(skillsDir, entry))
  }
  for (const entry of gcTargets(OPENCODE_PLUGINS_DIR, desiredPluginLinks, ctx, undefined, only === null ? undefined : `ocm--${only}--`)) {
    const stripped = entry.slice("ocm--".length)
    const split = stripped.indexOf("--")
    removedOutcome("plugin", stripped.slice(0, split), stripped.slice(split + 2), join(OPENCODE_PLUGINS_DIR, entry))
  }

  // a refused plugin keeps its mcp prefix (stale keys are removed) but its
  // keys are never written
  const mcpEnabled = refused.size === 0
    ? enabled
    : new Set([...(enabled ?? active.map((plugin) => plugin.name))].filter((name) => !refused.has(name)))
  outcomes.push(...syncMcp(active, dir, entry, mcpEnabled, approved, warnings, name))

  // a scoped pass never unregisters the skills path: other plugins'
  // rendered skills may still live there
  if (only === null || skillsRendered > 0) {
    const skills = setSkillsPath(skillsDir, skillsRendered > 0)
    if (skills.state === "skipped" || skills.state === "failed") warnings.push(skills.reason)
  }

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
    for (const plugin of discoverPlugins(dir)) {
      if (plugin.name in registered || taken.has(plugin.name)) continue
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
  } catch {}
  return { marketplace: name, outcomes, warnings }
}
