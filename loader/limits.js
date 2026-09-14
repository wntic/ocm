// spec 17: name and length limits, checked before any write so an over-long
// name is an ocm error naming the limit rather than a raw ENAMETOOLONG from
// the filesystem after a half-registered marketplace
import { existsSync } from "node:fs"
import { join } from "node:path"

const NAME_CHARS = 64
const COMPONENT_BYTES = 200

// the first limit this plugin breaks, or null: the plugin name itself, or any
// component file name (command, agent, plugin js, skill, mcp server key)
export function pluginLimitViolation(plugin) {
  if (plugin.name.length > NAME_CHARS) {
    return `plugin "${plugin.name}" exceeds ${NAME_CHARS} chars (${plugin.name.length})`
  }
  for (const type of ["command", "agent", "skill", "plugin", "mcp"]) {
    for (const name of plugin.components[type] ?? []) {
      const bytes = Buffer.byteLength(name)
      if (bytes > COMPONENT_BYTES) {
        return `plugin "${plugin.name}".${type} "${name}" exceeds ${COMPONENT_BYTES} bytes (${bytes})`
      }
    }
  }
  return null
}

// the refusal for a marketplace whose plugins break any limit, or null —
// every violation is listed; one bad component refuses the whole add
export function limitRefusal(plugins) {
  const lines = plugins.map(pluginLimitViolation).filter(Boolean)
  if (!lines.length) return null
  return lines.map((line) => `${line}\n  rename it in the marketplace, then re-run ocm add`).join("\n")
}

// spec 19: a plugin without plugin.json is not a plugin — add refuses the
// marketplace whole before any write, listing every missing manifest
export function manifestRefusal(name, plugins) {
  const missing = plugins.filter((plugin) => !existsSync(join(plugin.dir, "plugin.json")))
  if (!missing.length) return null
  const lines = missing.slice(0, 10).map((plugin) => `  plugins/${plugin.name}/plugin.json — missing`)
  if (missing.length > 10) lines.push(`  … and ${missing.length - 10} more`)
  return (
    `marketplace "${name}" is not installable — ${missing.length} ${missing.length === 1 ? "plugin has" : "plugins have"} no plugin.json\n` +
    `${lines.join("\n")}\n` +
    '  each needs at least { "description": "…" }; see ocm validate and the README'
  )
}
