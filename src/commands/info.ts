import { join } from "node:path"
import { OCM_LINKS_DIR, OPENCODE_AGENTS_DIR, OPENCODE_COMMANDS_DIR, OPENCODE_GLOBAL_CONFIG, OPENCODE_PLUGINS_DIR } from "../paths"
import { loadRegistry } from "../registry"
import type { MarketplaceEntry, MarketplacePlugin, PluginManifest, Registry } from "../types"

export interface InfoOptions {
  json?: boolean
}

interface Resolved {
  marketplace: string
  plugin: string
  entry: MarketplaceEntry
  record: MarketplacePlugin
}

// resolution never touches the marketplace directory: info answers from the
// registry cache and works for disabled and blocked plugins (spec 09)
function resolve(registry: Registry, arg: string): Resolved {
  const at = arg.indexOf("@")
  const plugin = at === -1 ? arg : arg.slice(0, at)
  const wanted = at === -1 ? null : arg.slice(at + 1)
  if (!plugin) throw new Error(`missing plugin name in "${arg}" (ocm search <query>)`)
  const providers = Object.entries(registry.marketplaces).filter(
    ([name, entry]) => entry.plugins[plugin] && (wanted === null || name === wanted),
  )
  if (!providers.length) {
    throw new Error(`plugin "${plugin}" not found in any marketplace (ocm search <query>, or ocm update)`)
  }
  if (providers.length > 1) {
    const names = providers.map(([name]) => name).join(", ")
    throw new Error(`plugin "${plugin}" is provided by more than one marketplace: ${names} (use ${plugin}@<marketplace>)`)
  }
  const [marketplace, entry] = providers[0]!
  return { marketplace, plugin, entry, record: entry.plugins[plugin]! }
}

interface ResultingComponent {
  type: string
  name: string
  source: string
  target: string
}

// the resulting opencode names, not the source filenames: "what do I type to
// use this" is the question info exists to answer (spec 09)
function resultingComponents(marketplace: string, plugin: string, record: MarketplacePlugin): ResultingComponent[] {
  const out: ResultingComponent[] = []
  for (const file of record.components.command ?? []) {
    out.push({
      type: "command",
      name: `${plugin}:${file.replace(/\.md$/, "")}`,
      source: join(record.source, "commands", file),
      target: join(OPENCODE_COMMANDS_DIR, `${plugin}:${file}`),
    })
  }
  for (const file of record.components.agent ?? []) {
    out.push({
      type: "agent",
      name: `${plugin}:${file.replace(/\.md$/, "")}`,
      source: join(record.source, "agents", file),
      target: join(OPENCODE_AGENTS_DIR, `${plugin}:${file}`),
    })
  }
  for (const rel of record.components.skill ?? []) {
    out.push({
      type: "skill",
      name: `${plugin}:${rel}`,
      source: join(record.source, "skills", rel, "SKILL.md"),
      target: join(OCM_LINKS_DIR, marketplace, "skills", `${plugin}--${rel.split("/").join("-")}`, "SKILL.md"),
    })
  }
  for (const file of record.components.plugin ?? []) {
    out.push({
      type: "plugin",
      name: `ocm--${plugin}--${file}`,
      source: join(record.source, "plugin", file),
      target: join(OPENCODE_PLUGINS_DIR, `ocm--${plugin}--${file}`),
    })
  }
  for (const server of record.components.mcp ?? []) {
    out.push({
      type: "mcp",
      name: `ocm--${plugin}--${server}`,
      source: join(record.source, "mcp.json"),
      target: `${OPENCODE_GLOBAL_CONFIG} (mcp)`,
    })
  }
  return out
}

// origin is debugging information, not decoration: annotated only where the
// two manifests disagreed, and the marketplace entry won by precedence
function origin(manifest: PluginManifest, field: string): string | undefined {
  return manifest.conflicts?.includes(field) ? "marketplace.json" : undefined
}

function field(label: string, value: string | undefined, note?: string): void {
  if (value === undefined) return
  console.log(`  ${label.padEnd(13)}${value}${note ? `  (${note})` : ""}`)
}

function age(iso: string): string {
  const ms = Date.now() - Date.parse(iso)
  if (Number.isNaN(ms) || ms < 60_000) return "just now"
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

export function info(arg: string, options: InfoOptions = {}): void {
  const { marketplace, plugin, entry, record } = resolve(loadRegistry(), arg)
  const manifest = record.manifest
  if (options.json) {
    console.log(JSON.stringify({
      plugin,
      marketplace,
      description: manifest.description ?? null,
      version: record.version,
      category: manifest.category ?? null,
      tags: manifest.tags ?? null,
      keywords: manifest.keywords ?? null,
      homepage: manifest.homepage ?? null,
      license: manifest.license ?? null,
      enabled: record.enabled,
      installedAt: record.installedAt,
      url: entry.url,
      ref: entry.ref,
      revision: entry.revision,
      trust: entry.trust.code,
      lastSync: entry.lastSync,
      components: resultingComponents(marketplace, plugin, record),
    }, null, 2))
    return
  }
  console.log(`${plugin} @ ${marketplace}`)
  field("description", manifest.description, origin(manifest, "description"))
  field("version", record.version ?? undefined, origin(manifest, "version"))
  field("category", manifest.category, origin(manifest, "category"))
  field("tags", manifest.tags?.join(", "))
  field("homepage", manifest.homepage)
  field("license", manifest.license)
  field("enabled", record.enabled ? "yes" : "no")
  field("installed", record.installedAt ?? undefined)
  field("marketplace", `${entry.url}${entry.ref ? `  @ ${entry.ref}` : ""}`)
  if (entry.revision) {
    const synced = entry.lastSync ? `  (synced ${age(entry.lastSync.at)})` : ""
    field("revision", `${entry.revision.slice(0, 7)}${synced}`)
  }
  field("trust", entry.trust.code)
  const components = resultingComponents(marketplace, plugin, record)
  if (components.length) {
    console.log("  components")
    for (const component of components) {
      console.log(`    ${component.type.padEnd(8)}${component.name}  → ${component.target}`)
    }
  }
}
