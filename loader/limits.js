// spec 17: name and length limits, checked before any write so an over-long
// name is an ocm error naming the limit rather than a raw ENAMETOOLONG from
// the filesystem after a half-registered marketplace
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
