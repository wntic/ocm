import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { dirClashes, discoverPlugins } from "./discovery.js"
import { isRecord } from "./registry.js"

function readJsonRecord(file) {
  if (!existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    if (isRecord(parsed)) return parsed
  } catch {}
  return undefined
}

// a `source` or `mcpServers` path: ./-relative and inside the marketplace
function relativePath(source) {
  if (!source.startsWith("./") || source.split("/").includes("..")) return null
  return source.slice(2)
}

// the metadata fields plugin.json and a marketplace entry share; the entry
// wins because it is the more specific declaration (spec 06)
function metadataFrom(raw) {
  const manifest = {}
  if (!raw) return manifest
  if (typeof raw.description === "string") manifest.description = raw.description
  if (typeof raw.category === "string") manifest.category = raw.category
  if (typeof raw.version === "string") manifest.version = raw.version
  if (typeof raw.homepage === "string") manifest.homepage = raw.homepage
  if (typeof raw.license === "string") manifest.license = raw.license
  if (Array.isArray(raw.tags) && raw.tags.every((tag) => typeof tag === "string")) manifest.tags = raw.tags
  if (Array.isArray(raw.keywords) && raw.keywords.every((keyword) => typeof keyword === "string")) {
    manifest.keywords = raw.keywords
  }
  return manifest
}

// spec 06: a plugin.json name that disagrees with the directory name is a
// warning; the directory name wins because that is what the materializer
// namespaces from
export function nameDisagreement(pluginDir, pluginName) {
  const raw = readJsonRecord(join(pluginDir, "plugin.json"))
  if (typeof raw?.name !== "string" || raw.name === pluginName) return null
  return (
    `plugin "${pluginName}": plugin.json name "${raw.name}" disagrees with the directory name "${pluginName}"; ` +
    "the directory name wins — rename the directory or fix plugin.json"
  )
}

function readEntries(marketplaceDir) {
  const entries = new Map()
  const raw = readJsonRecord(join(marketplaceDir, "marketplace.json"))
  if (!Array.isArray(raw?.plugins)) return entries
  for (const entry of raw.plugins) {
    if (isRecord(entry) && typeof entry.name === "string") entries.set(entry.name, entry)
  }
  return entries
}

export function discoverMarketplace(marketplaceDir) {
  const warnings = []
  const entries = readEntries(marketplaceDir)
  const plugins = new Map()
  for (const plugin of discoverPlugins(marketplaceDir)) {
    const entry = entries.get(plugin.name)
    const disagreement = nameDisagreement(plugin.dir, plugin.name)
    if (disagreement) warnings.push(disagreement)
    const fromPlugin = metadataFrom(readJsonRecord(join(plugin.dir, "plugin.json")))
    const fromEntry = metadataFrom(entry)
    const manifest = { ...fromPlugin, ...fromEntry }
    // the disagreement is cached so info can annotate it from the registry
    // alone, with the marketplace directory deleted (spec 09)
    const conflicts = Object.keys(fromEntry).filter(
      (key) => key in fromPlugin && JSON.stringify(fromPlugin[key]) !== JSON.stringify(fromEntry[key]),
    )
    if (conflicts.length) manifest.conflicts = conflicts.sort()
    const components = { ...plugin.components }
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
export function discoveryError(plugins) {
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
function tuiModule(plugin) {
  for (const file of plugin.components.plugin ?? []) {
    for (const dir of ["plugin", "plugins"]) {
      let content
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

export function readManifest(marketplaceDir) {
  const file = join(marketplaceDir, "marketplace.json")
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    return {
      name: isRecord(parsed) && typeof parsed.name === "string" ? parsed.name : undefined,
      description: isRecord(parsed) && typeof parsed.description === "string" ? parsed.description : undefined,
    }
  } catch {
    return {}
  }
}
