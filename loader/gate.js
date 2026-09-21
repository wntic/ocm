// brief 31 §4: the gates that decide what is recorded also decide what is
// linked — one refusal answer for the materializer. This lives outside
// manifest-gate.js because the composed gate needs limits.js, which that
// module's no-sibling-imports rule forbids.
import { existsSync } from "node:fs"
import { join } from "node:path"
import { pluginLimitViolation } from "./limits.js"
import { pluginGateFindings } from "./manifest-gate.js"
import { OPENCODE_AGENTS_DIR, OPENCODE_COMMANDS_DIR, OPENCODE_PLUGINS_DIR } from "./paths.js"

// the first reason this plugin is refused, or null. The limit never
// grandfathers; a plugin already recorded in the registry is exempt from
// the manifest check (brief 29)
export function pluginRefusal(root, plugin, grandfathered) {
  const violation = pluginLimitViolation(plugin)
  if (violation) return { code: "limit", message: violation }
  if (grandfathered) return null
  const finding = pluginGateFindings(root, plugin)[0]
  return finding ? { code: finding.code, message: finding.message } : null
}

// the dests materialize would have linked, mirroring its name construction;
// `dirs` is the source-directory resolution order, plural first
const FILE_KINDS = [
  { type: "command", dirs: ["commands", "command"], dest: (plugin, name) => join(OPENCODE_COMMANDS_DIR, `${plugin.name}:${name}`) },
  { type: "agent", dirs: ["agents", "agent"], dest: (plugin, name) => join(OPENCODE_AGENTS_DIR, `${plugin.name}:${name}`) },
  { type: "plugin", dirs: ["plugin", "plugins"], dest: (plugin, name) => join(OPENCODE_PLUGINS_DIR, `ocm--${plugin.name}--${name}`) },
]

function sourcePath(plugin, dirs, name) {
  const dir = dirs.find((d) => existsSync(join(plugin.dir, d, name))) ?? dirs[0]
  return join(plugin.dir, dir, name)
}

// one skipped outcome per component of a refused plugin, so the skip leaves
// the registry and the report in the same commit
export function refusalOutcomes(plugin, reason, skillsDir) {
  const outcomes = []
  for (const kind of FILE_KINDS) {
    for (const name of plugin.components[kind.type] ?? []) {
      outcomes.push({ type: kind.type, plugin: plugin.name, component: name, source: sourcePath(plugin, kind.dirs, name), dest: kind.dest(plugin, name), state: "skipped", reason })
    }
  }
  for (const rel of plugin.components.skill ?? []) {
    outcomes.push({
      type: "skill",
      plugin: plugin.name,
      component: rel,
      source: sourcePath(plugin, ["skills", "skill"], rel),
      dest: join(skillsDir, `${plugin.name}--${rel.split("/").join("-")}`),
      state: "skipped",
      reason,
    })
  }
  for (const key of plugin.components.mcp ?? []) {
    outcomes.push({ type: "mcp", plugin: plugin.name, component: key, source: null, dest: `ocm--${plugin.name}--${key}`, state: "skipped", reason })
  }
  return outcomes
}
