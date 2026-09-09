import { loadRegistry } from "../registry"

export interface ListOptions {
  all?: boolean
  json?: boolean
}

export function list(options: ListOptions = {}): void {
  const registry = loadRegistry()
  if (options.json) {
    console.log(JSON.stringify(registry, null, 2))
    return
  }
  const entries = Object.entries(registry.marketplaces)
  if (!entries.length) {
    console.log("no marketplaces added yet (ocm add <url|path>)")
    return
  }
  for (const [name, entry] of entries) {
    console.log(`${name}${options.all ? ` (${entry.mode})` : ""}`)
    console.log(`  source: ${entry.url}`)
    if (entry.revision) console.log(`  revision: ${entry.revision}`)
    if (options.all && entry.lastSync && !entry.lastSync.ok) {
      console.log(`  \x1b[31mlast sync failed: ${entry.lastSync.error}\x1b[0m`)
    }
    for (const [pluginName, plugin] of Object.entries(entry.plugins)) {
      if (!options.all && !plugin.enabled) continue
      const parts: string[] = []
      if (plugin.components.agent) parts.push(`agents: ${plugin.components.agent.join(", ")}`)
      if (plugin.components.command) parts.push(`commands: ${plugin.components.command.join(", ")}`)
      if (plugin.components.skill) parts.push(`skills: ${plugin.components.skill.join(", ")}`)
      if (plugin.components.plugin) parts.push(`plugins: ${plugin.components.plugin.join(", ")}`)
      if (plugin.components.mcp) parts.push(`mcp: ${plugin.components.mcp.join(", ")}`)
      console.log(`  ${pluginName}${options.all && !plugin.enabled ? " (disabled)" : ""}`)
      for (const part of parts) console.log(`    ${part}`)
    }
  }
}
