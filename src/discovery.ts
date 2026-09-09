import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { dirClashes, discoverPlugins } from "../loader/core.js"
import type { ComponentType, DiscoveredPlugin, PluginManifest } from "./types"

export type { DiscoveredPlugin } from "./types"

export interface DiscoveredMarketplace {
  plugins: Map<string, DiscoveredPlugin>
  warnings: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readJsonRecord(file: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
    if (isRecord(parsed)) return parsed
  } catch {}
  return undefined
}

// a `source` or `mcpServers` path: ./-relative and inside the marketplace
function relativePath(source: string): string | null {
  if (!source.startsWith("./") || source.split("/").includes("..")) return null
  return source.slice(2)
}

// the metadata fields plugin.json and a marketplace entry share; the entry
// wins because it is the more specific declaration (spec 06)
function metadataFrom(raw: Record<string, unknown> | undefined): PluginManifest {
  const manifest: PluginManifest = {}
  if (!raw) return manifest
  if (typeof raw.description === "string") manifest.description = raw.description
  if (typeof raw.category === "string") manifest.category = raw.category
  if (typeof raw.version === "string") manifest.version = raw.version
  if (Array.isArray(raw.tags) && raw.tags.every((tag) => typeof tag === "string")) {
    manifest.tags = raw.tags as string[]
  }
  return manifest
}

// spec 06: a plugin.json name that disagrees with the directory name is a
// warning; the directory name wins because that is what the materializer
// namespaces from
export function nameDisagreement(pluginDir: string, pluginName: string): string | null {
  const raw = readJsonRecord(join(pluginDir, "plugin.json"))
  if (typeof raw?.name !== "string" || raw.name === pluginName) return null
  return (
    `plugin "${pluginName}": plugin.json name "${raw.name}" disagrees with the directory name "${pluginName}"; ` +
    "the directory name wins — rename the directory or fix plugin.json"
  )
}

function readEntries(marketplaceDir: string): Map<string, Record<string, unknown>> {
  const entries = new Map<string, Record<string, unknown>>()
  const raw = readJsonRecord(join(marketplaceDir, "marketplace.json"))
  if (!Array.isArray(raw?.plugins)) return entries
  for (const entry of raw.plugins) {
    if (isRecord(entry) && typeof entry.name === "string") entries.set(entry.name, entry)
  }
  return entries
}

// spec 08: renames come from each discovered plugin's plugin.json, with the
// marketplace manifest winning on conflict
export function readRenames(marketplaceDir: string, plugins: DiscoveredPlugin[]): Record<string, string | null> {
  const renames: Record<string, string | null> = {}
  for (const plugin of plugins) collectRenames(readJsonRecord(join(plugin.dir, "plugin.json")), renames)
  collectRenames(readJsonRecord(join(marketplaceDir, "marketplace.json")), renames)
  return renames
}

function collectRenames(raw: Record<string, unknown> | undefined, into: Record<string, string | null>): void {
  if (!raw || !isRecord(raw.renames)) return
  for (const [from, to] of Object.entries(raw.renames)) {
    if (typeof to === "string" || to === null) into[from] = to
  }
}

export function discoverMarketplace(marketplaceDir: string): DiscoveredMarketplace {
  const warnings: string[] = []
  const entries = readEntries(marketplaceDir)
  const plugins = new Map<string, DiscoveredPlugin>()
  for (const plugin of discoverPlugins(marketplaceDir)) {
    const entry = entries.get(plugin.name)
    const disagreement = nameDisagreement(plugin.dir, plugin.name)
    if (disagreement) warnings.push(disagreement)
    const manifest: PluginManifest = {
      ...metadataFrom(readJsonRecord(join(plugin.dir, "plugin.json"))),
      ...metadataFrom(entry),
    }
    const components: Partial<Record<ComponentType, string[]>> = { ...plugin.components }
    if (typeof entry?.defaultEnabled === "boolean") manifest.defaultEnabled = entry.defaultEnabled
    if (typeof entry?.mcpServers === "string") {
      const rel = relativePath(entry.mcpServers)
      const servers = rel === null ? undefined : readJsonRecord(join(marketplaceDir, rel))
      if (servers) {
        manifest.mcpServers = entry.mcpServers
        components.mcp = Object.keys(servers).sort()
      } else {
        warnings.push(`plugin "${plugin.name}": mcpServers path "${entry.mcpServers}" is not a JSON object in ${marketplaceDir}`)
      }
    }
    plugins.set(plugin.name, {
      name: plugin.name,
      dir: plugin.dir,
      source: plugin.dir,
      components,
      manifest,
    })
  }
  // a bad source is a warning, never a failure: the plugin directory is
  // still discovered by the scan (spec 06)
  for (const [name, entry] of entries) {
    const rel = typeof entry.source === "string" ? relativePath(entry.source) : null
    if (rel === null || !existsSync(join(marketplaceDir, rel))) {
      warnings.push(`plugin "${name}" source ${JSON.stringify(entry.source ?? null)} not found in ${marketplaceDir}; the entry is skipped`)
    }
  }
  return { plugins, warnings }
}

// add refuses a marketplace whose singular and plural component directories
// define the same name, or that ships a tui plugin (spec 06)
export function discoveryError(plugins: DiscoveredPlugin[]): string | null {
  for (const plugin of plugins) {
    const clashes = dirClashes(plugin.dir)
    if (clashes.length) {
      return (
        `plugin "${plugin.name}" has a component name clash: ${clashes.join("; ")}\n` +
        "  remove one directory of each clashing pair; ocm refuses to guess"
      )
    }
    const tui = tuiModule(plugin)
    if (tui) {
      return (
        `plugin "${plugin.name}" ships a tui plugin (${tui}): tui plugins are not supported\n` +
        "  shipping one would edit tui.json on behalf of third-party code; ship a server plugin ({ id, server }) instead"
      )
    }
  }
  return null
}

// a static check: a module default-exporting a tui member is a tui plugin
function tuiModule(plugin: DiscoveredPlugin): string | null {
  for (const file of plugin.components.plugin ?? []) {
    for (const dir of ["plugin", "plugins"]) {
      let content: string
      try {
        content = readFileSync(join(plugin.dir, dir, file), "utf8")
      } catch {
        continue
      }
      if (/\btui\s*:/.test(content)) return `${dir}/${file}`
    }
  }
  return null
}

interface MarketplaceManifest {
  name?: unknown
  description?: unknown
}

export function readManifest(marketplaceDir: string): { name?: string; description?: string } {
  const file = join(marketplaceDir, "marketplace.json")
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as MarketplaceManifest
    return {
      name: typeof parsed.name === "string" ? parsed.name : undefined,
      description: typeof parsed.description === "string" ? parsed.description : undefined,
    }
  } catch {
    return {}
  }
}
