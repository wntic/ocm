// The collision surface (spec 18): plugin names are globally unique across
// marketplaces (spec 04, axis 4), and every refusal names the plugin, both
// marketplaces and the conflicting paths on both sides.

// the first marketplace other than `self` to provide a name is the incumbent
export function incumbentMarketplace(registry, self, pluginName) {
  for (const [name, entry] of Object.entries(registry.marketplaces)) {
    if (name !== self && entry.plugins[pluginName]) return name
  }
}

// the marketplace that actually holds a name: an incumbent whose record is
// enabled. A disabled rival never materialized and blocks no one — the
// former owner re-installing its own uninstalled plugin stays legal.
export function nameHolder(registry, self, pluginName) {
  const incumbent = incumbentMarketplace(registry, self, pluginName)
  if (!incumbent) return null
  return registry.marketplaces[incumbent].plugins[pluginName].enabled ? incumbent : null
}

// the materialized destinations a plugin's components map to; skills are
// excluded because their mirrors live under per-marketplace directories
function destNames(pluginName, components) {
  const dests = []
  for (const file of components.command ?? []) dests.push(`${pluginName}:${file}`)
  for (const file of components.agent ?? []) dests.push(`${pluginName}:${file}`)
  for (const file of components.plugin ?? []) dests.push(`ocm--${pluginName}--${file}`)
  for (const server of components.mcp ?? []) dests.push(`ocm--${pluginName}--${server}`)
  return dests
}

function collisionPathLines(pluginName, incumbentName, incumbentComponents, selfName, selfComponents) {
  const theirs = new Set(destNames(pluginName, incumbentComponents))
  return destNames(pluginName, selfComponents)
    .filter((dest) => theirs.has(dest))
    .map((dest) => `  ${dest} from marketplace "${incumbentName}" conflicts with ${dest} from marketplace "${selfName}"`)
}

// spec 18 §2: the add-time refusal lists every colliding plugin with its
// paths, capped at 10
export function collisionError(registry, name, plugins) {
  const colliding = []
  for (const plugin of plugins) {
    const incumbent = incumbentMarketplace(registry, name, plugin.name)
    if (incumbent) colliding.push({ plugin, incumbent })
  }
  if (!colliding.length) return null
  const lines = []
  for (const { plugin, incumbent } of colliding.slice(0, 10)) {
    lines.push(`plugin "${plugin.name}" is already provided by marketplace "${incumbent}"`)
    const record = registry.marketplaces[incumbent].plugins[plugin.name]
    lines.push(...collisionPathLines(plugin.name, incumbent, record.components, name, plugin.components))
  }
  if (colliding.length > 10) lines.push(`… and ${colliding.length - 10} more`)
  lines.push(`not adding "${name}"; remove one, or ask its author to rename`)
  return lines.join("\n")
}

// spec 18 §1: the install refusal names the incumbent, the conflicting
// paths on both sides, and the way out
export function installRefusal(registry, self, pluginName, incumbent) {
  const incumbentRecord = registry.marketplaces[incumbent].plugins[pluginName]
  const selfRecord = registry.marketplaces[self].plugins[pluginName]
  return [
    `plugin "${pluginName}" is already provided by marketplace "${incumbent}"`,
    ...collisionPathLines(pluginName, incumbent, incumbentRecord.components, self, selfRecord.components),
    "install with --force to take the name over, or ask the author to rename",
  ].join("\n")
}
