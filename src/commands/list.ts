import { existsSync } from "node:fs"
import { loadRegistry } from "../registry"
import type { MarketplaceEntry } from "../types"
import { age, bareComponents, componentLine, pendingExecutables, shippedExecutables, wrapLine } from "./display"
import { componentRoot } from "../../loader/core.js"
import type { CoreExecutableComponent } from "../../loader/core.js"

export interface ListOptions {
  all?: boolean
  json?: boolean
  stranded?: boolean
}

// the marketplace row's parenthesised markers, in print order: mode, pin,
// awaiting-trust, failed sync (specs 25 §2/§5/§6), then the missing-clone
// marker in the same set (spec 33 §4)
function rowMarkers(entry: MarketplaceEntry, all: boolean, pending: CoreExecutableComponent[], name: string, cloneMissing: boolean): string {
  const markers: string[] = []
  if (all) markers.push(entry.mode)
  if (entry.ref) markers.push(`pinned @ ${entry.ref}`)
  if (entry.trustPending) {
    markers.push(pending.length
      ? `${pending.length} component${pending.length === 1 ? "" : "s"} awaiting trust`
      : "components awaiting trust")
  }
  if (entry.lastSync && !entry.lastSync.ok) markers.push(`! sync failed ${age(entry.lastSync.at)}`)
  // a local directory is the user's — the remedy is restore-or-remove, not a
  // re-clone (spec 20 §3, rendered as doctor renders it)
  if (cloneMissing) {
    markers.push(entry.local
      ? `clone missing — restore the directory, or run ocm remove ${name}`
      : "clone missing — ocm update re-clones")
  }
  return markers.length ? ` (${markers.join(", ")})` : ""
}

export function list(options: ListOptions = {}): void {
  const registry = loadRegistry()
  if (options.json) {
    console.log(JSON.stringify(registry, null, 2))
    return
  }
  const entries = Object.entries(registry.marketplaces)
  if (!entries.length) {
    // the stranded notice already explained why the home looks empty
    if (!options.stranded) console.log("no marketplaces added yet (ocm add <url|path>)")
    return
  }
  for (const [name, entry] of entries) {
    const pending = pendingExecutables(entry)
    const cloneMissing = !existsSync(componentRoot(entry))
    console.log(`${name}${rowMarkers(entry, options.all === true, pending, name, cloneMissing)}`)
    console.log(`  source: ${entry.url}`)
    // display shortens; the registry keeps the full sha (spec 08)
    const short = entry.revision ? entry.revision.slice(0, 7) : null
    if (short) console.log(`  revision: ${short}`)
    // a local directory never syncs, so it has no age to state (spec 25 §6);
    // neither does a directory that no longer exists — a sync age for a gone
    // clone is the lie F112 recorded (spec 33 §4)
    if (options.all && !entry.local && !cloneMissing) {
      const sync = entry.lastSync
      console.log(`  ${!sync ? "never synced" : sync.ok ? `synced ${age(sync.at)}` : `sync failed ${age(sync.at)}`}`)
    }
    if (options.all && entry.lastSync && !entry.lastSync.ok) {
      // spec 23 §1: a problem line — stderr, and never styled red
      console.error(`  last sync failed: ${entry.lastSync.error}`)
    }
    // brief 36 §6: stored sync warnings, stderr, until a later sync replaces them
    for (const text of entry.lastSync?.warnings ?? []) console.error(`  warning: ${text}`)
    for (const component of pending) {
      console.log(`  ${component.rel} — awaiting trust (ocm trust ${name})`)
    }
    // a not-granted marketplace's executables never linked, so the record
    // does not carry them; the blocked lines read the tree instead
    const shipped = entry.trust.code !== "granted" ? shippedExecutables(entry) : null
    for (const [pluginName, plugin] of Object.entries(entry.plugins)) {
      if (!options.all && !plugin.enabled) continue
      const bare = bareComponents(plugin.components)
      const parts: string[] = []
      if (bare.agent) parts.push(componentLine("agent", bare.agent))
      if (bare.command) parts.push(componentLine("command", bare.command))
      if (bare.skill) parts.push(componentLine("skill", bare.skill))
      // a not-granted marketplace's executables list as blocked with the remedy (spec 25 §1)
      const blocked = entry.trust.code !== "granted" ? ` (blocked — ocm trust ${name})` : ""
      const exec = shipped?.get(pluginName)
      const pluginFiles = bare.plugin?.length ? bare.plugin : exec?.plugin
      const mcpServers = bare.mcp?.length ? bare.mcp : exec?.mcp
      if (pluginFiles?.length) parts.push(`${componentLine("plugin", pluginFiles)}${blocked}`)
      if (mcpServers?.length) parts.push(`${componentLine("mcp", mcpServers)}${blocked}`)
      // the marketplace revision is the implicit version of a versionless
      // plugin (spec 08)
      const version = plugin.version ?? (short ? `@${short}` : null)
      const markers = `${version ? ` (${version})` : ""}${options.all && !plugin.enabled ? " (disabled)" : ""}`
      console.log(`  ${pluginName}${markers}`)
      for (const part of parts) for (const line of wrapLine(4, part.split(" "))) console.log(line)
    }
  }
}
