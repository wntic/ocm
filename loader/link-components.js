import { existsSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { link, mirror } from "./links.js"
import { linkOutcome, removedOutcome } from "./outcomes.js"
import { clearRendered, renderRooted, renderSkillMd } from "./render.js"
import { OPENCODE_AGENTS_DIR, OPENCODE_COMMANDS_DIR, OPENCODE_PLUGINS_DIR } from "./paths.js"
import { componentKey } from "./trust.js"

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

export function linkComponents(st, plugin, folded) {
  linkCommands(st, plugin, folded)
  linkAgents(st, plugin, folded)
  linkSkills(st, plugin, folded)
  linkPluginFiles(st, plugin, folded)
}

function linkCommands(st, plugin, folded) {
  for (const file of plugin.components.command ?? []) {
    if (folded.has(`command/${file}`)) continue
    const source = resolveSource(plugin.dir, ["commands", "command"], file, st.ctx, plugin.name)
    if (!source) continue
    const dest = join(OPENCODE_COMMANDS_DIR, `${plugin.name}:${file}`)
    st.desiredCommands.add(`${plugin.name}:${file}`)
    const warnStart = st.ctx.warnings.length
    const rendered = renderRooted(st, source, dest, plugin.name)
    if (rendered === null) clearRendered(dest, source, st.dir)
    const status = rendered ?? link(source, dest, st.ctx, plugin.name, file)
    linkOutcome(st, "command", plugin.name, file, source, dest, status, warnStart)
  }
}

function linkAgents(st, plugin, folded) {
  for (const file of plugin.components.agent ?? []) {
    if (folded.has(`agent/${file}`)) continue
    const source = resolveSource(plugin.dir, ["agents", "agent"], file, st.ctx, plugin.name)
    if (!source) continue
    const dest = join(OPENCODE_AGENTS_DIR, `${plugin.name}:${file}`)
    st.desiredAgents.add(`${plugin.name}:${file}`)
    const warnStart = st.ctx.warnings.length
    const rendered = renderRooted(st, source, dest, plugin.name)
    if (rendered === null) clearRendered(dest, source, st.dir)
    const status = rendered ?? link(source, dest, st.ctx, plugin.name, file)
    linkOutcome(st, "agent", plugin.name, file, source, dest, status, warnStart)
  }
}

function linkSkills(st, plugin, folded) {
  for (const rel of plugin.components.skill ?? []) {
    if (folded.has(`skill/${rel}`)) continue
    const sourceDir = resolveSource(plugin.dir, ["skills", "skill"], rel, st.ctx, plugin.name)
    if (!sourceDir) continue
    const skillMd = join(sourceDir, "SKILL.md")
    let transformed = null
    try {
      transformed = renderSkillMd(readFileSync(skillMd, "utf8"), plugin.name)
    } catch {
      // an unreadable SKILL.md reads as no frontmatter name — skipped below
    }
    const mirrorName = `${plugin.name}--${rel.split("/").join("-")}`
    const mirrorDir = join(st.skillsDir, mirrorName)
    if (transformed === null) {
      const reason = `skipped ${skillMd}: no name in frontmatter`
      st.warnings.push(reason)
      // brief 31 §4: the skip is an outcome, not only a warning — it
      // leaves the registry and the report in the same commit
      st.outcomes.push({ type: "skill", plugin: plugin.name, component: rel, source: sourceDir, dest: mirrorDir, state: "skipped", reason })
      continue
    }
    mirrorSkill(st, plugin, rel, sourceDir, mirrorDir, mirrorName, transformed)
  }
}

function mirrorSkill(st, plugin, rel, sourceDir, mirrorDir, mirrorName, transformed) {
  st.skillsRendered += 1
  st.desiredMirrors.add(mirrorName)
  const warnStart = st.ctx.warnings.length
  const mirrored = mirror(sourceDir, mirrorDir, { "SKILL.md": () => transformed }, st.ctx, plugin.name, rel)
  let state
  let reason = null
  if (mirrored.status === "skipped") {
    state = "skipped"
    reason = st.ctx.warnings.length > warnStart ? st.ctx.warnings[st.ctx.warnings.length - 1] : null
  } else if (mirrored.created > 0) {
    // a sibling link or the render wrote something: the restart notice
    // fires exactly when today's mirror.created did
    state = "created"
  } else {
    state = "current"
  }
  if (state === "current" && st.changed !== null && st.changed.has(relative(st.dir, sourceDir))) state = "refreshed"
  const outcome = { type: "skill", plugin: plugin.name, component: rel, source: sourceDir, dest: mirrorDir, state, reason }
  // a takeover inside the mirror records the mirror's child, not the
  // mirror itself — any displacement under it belongs to this outcome
  for (const [displacedDest, target] of st.ctx.displacements) {
    if (displacedDest.startsWith(`${mirrorDir}/`)) outcome.displaced = target
  }
  st.outcomes.push(outcome)
  for (const entry of mirrored.removed) {
    removedOutcome(st, "skill", plugin.name, `${rel}/${entry}`, join(mirrorDir, entry))
  }
}

function linkPluginFiles(st, plugin, folded) {
  for (const file of plugin.components.plugin ?? []) {
    if (folded.has(`plugin/${file}`)) continue
    const source = resolveSource(plugin.dir, ["plugin", "plugins"], file, st.ctx, plugin.name)
    if (!source) continue
    const dest = join(OPENCODE_PLUGINS_DIR, `ocm--${plugin.name}--${file}`)
    if (!st.approved.get(componentKey("plugin", plugin.name, file))) {
      const reason = `blocked (untrusted): ${plugin.name}:${file} not linked — run \`ocm trust ${st.name}\` to approve`
      st.warnings.push(reason)
      st.outcomes.push({ type: "plugin", plugin: plugin.name, component: file, source, dest, state: "blocked", reason })
      continue
    }
    st.desiredPluginLinks.add(`ocm--${plugin.name}--${file}`)
    const warnStart = st.ctx.warnings.length
    const status = link(source, dest, st.ctx, plugin.name, file)
    linkOutcome(st, "plugin", plugin.name, file, source, dest, status, warnStart)
  }
}
