import { existsSync, mkdirSync, copyFileSync, rmSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import {
  OCM_MARKETPLACES_DIR,
  OCM_LOADER_TARGET,
  OPENCODE_GLOBAL_DIR,
  marketplaceDir,
  marketplaceNameFromUrl,
} from "../paths"
import { loadRegistry, saveRegistry, readGlobalConfig, writeGlobalConfig, refreshLinks, removeLinks, registerPlugins } from "../install"
import { clone, pull } from "../git"
import { discoverMarketplace } from "../discovery"
import type { MarketplaceEntry } from "../types"
import { installLoader } from "../loader"
function loaderSource(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, "..", "..", "loader", "ocm-loader.js"),
    join(here, "ocm-loader.js"),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error("ocm-loader.js not found")
}

function isGitUrl(source: string): boolean {
  return /^https?:|^git@|^file:\/\//.test(source)
}

function parseSource(source: string): { url: string; name: string } {
  if (isGitUrl(source)) {
    return { url: source, name: marketplaceNameFromUrl(source) }
  }
  const absolute = source.startsWith("~") ? join(process.env.HOME ?? "", source.slice(2)) : source
  if (!existsSync(absolute)) {
    throw new Error(`path does not exist: ${source}`)
  }
  return { url: absolute, name: basename(absolute).toLowerCase() }
}

function basename(p: string): string {
  return p.replace(/\/+$/, "").split("/").pop() ?? p
}

export function add(source: string): void {
  const { url, name } = parseSource(source)
  const registry = loadRegistry()

  if (registry.marketplaces[name]) {
    throw new Error(`marketplace "${name}" already added (use "ocm update ${name}")`)
  }

  const dir = marketplaceDir(name)
  mkdirSync(OCM_MARKETPLACES_DIR, { recursive: true })

  if (isGitUrl(url)) {
    console.log(`cloning ${url}...`)
    clone(url, dir)
  } else {
    console.log(`linking local marketplace ${url}`)
    registry.marketplaces[name] = {
      url,
      path: url,
      dir: url,
      addedAt: new Date().toISOString(),
      plugins: {},
    }
    const plugins = [...discoverMarketplace(url).values()]
    const entry = registry.marketplaces[name]!
    registerPlugins(name, entry, plugins)
    refreshLinks(name, plugins)
    saveRegistry(registry)
    reportAdded(name, plugins)
    return
  }

  const plugins = [...discoverMarketplace(dir).values()]
  if (!plugins.length) {
    rmSync(dir, { recursive: true, force: true })
    throw new Error(`no plugins found in ${url} (expected plugins/<name>/{agents,commands,skills})`)
  }

  const entry: MarketplaceEntry = {
    url,
    path: url,
    dir,
    addedAt: new Date().toISOString(),
    plugins: {},
  }
  registry.marketplaces[name] = entry
  registerPlugins(name, entry, plugins)
  refreshLinks(name, plugins)
  installLoader()
  saveRegistry(registry)
  reportAdded(name, plugins)
}

function reportAdded(name: string, plugins: import("../discovery").DiscoveredPlugin[]): void {
  console.log(`added marketplace "${name}"`)
  for (const plugin of plugins) {
    const parts: string[] = []
    if (plugin.components.agent) parts.push(`${plugin.components.agent.length} agents`)
    if (plugin.components.command) parts.push(`${plugin.components.command.length} commands`)
    if (plugin.components.skill) parts.push(`${plugin.components.skill.length} skills`)
    console.log(`  ${plugin.name} (${parts.join(", ")})`)
  }
  console.log(`components are now globally available in all projects`)
}

export function remove(name: string): void {
  const registry = loadRegistry()
  const entry = registry.marketplaces[name]
  if (!entry) {
    throw new Error(`marketplace "${name}" not found (ocm list)`)
  }
  removeLinks(name)
  if (entry.dir.startsWith(OCM_MARKETPLACES_DIR)) {
    rmSync(entry.dir, { recursive: true, force: true })
  }
  delete registry.marketplaces[name]
  saveRegistry(registry)
  console.log(`removed marketplace "${name}"`)
}

export function update(name?: string): void {
  const registry = loadRegistry()
  const names = name ? [name] : Object.keys(registry.marketplaces)
  if (!names.length) {
    console.log("no marketplaces added yet (ocm add <url|path>)")
    return
  }
  for (const marketplaceName of names) {
    const entry = registry.marketplaces[marketplaceName]
    if (!entry) {
      console.error(`marketplace "${marketplaceName}" not found, skipping`)
      continue
    }
    if (isGitUrl(entry.url)) {
      console.log(`updating ${marketplaceName}...`)
      const result = pull(entry.dir)
      if (!result.ok) {
        console.error(`  failed: ${result.output}`)
        continue
      }
      console.log(`  ${result.changed ? "updated to new revision" : "already up to date"}`)
    } else {
      console.log(`${marketplaceName} is local (${entry.url}), refreshing links`)
    }
    const plugins = [...discoverMarketplace(entry.dir).values()]
    registerPlugins(marketplaceName, entry, plugins)
    refreshLinks(marketplaceName, plugins)
  }
  saveRegistry(registry)
}

export function list(): void {
  const registry = loadRegistry()
  const entries = Object.entries(registry.marketplaces)
  if (!entries.length) {
    console.log("no marketplaces added yet (ocm add <url|path>)")
    return
  }
  for (const [name, entry] of entries) {
    console.log(`${name}`)
    console.log(`  source: ${entry.url}`)
    for (const [pluginName, plugin] of Object.entries(entry.plugins)) {
      const parts: string[] = []
      if (plugin.components.agent) parts.push(`agents: ${plugin.components.agent.join(", ")}`)
      if (plugin.components.command) parts.push(`commands: ${plugin.components.command.join(", ")}`)
      if (plugin.components.skill) parts.push(`skills: ${plugin.components.skill.join(", ")}`)
      console.log(`  ${pluginName}`)
      for (const part of parts) console.log(`    ${part}`)
    }
  }
}

export function scan(source: string): void {
  const { name, url } = parseSource(source)
  let dir = url
  if (isGitUrl(url)) {
    dir = join(OCM_MARKETPLACES_DIR, `.scan-${name}-${Date.now()}`)
    mkdirSync(OCM_MARKETPLACES_DIR, { recursive: true })
    try {
      console.log(`cloning ${url}...`)
      clone(url, dir)
    } catch (err) {
      rmSync(dir, { recursive: true, force: true })
      throw err
    }
  }
  try {
    const plugins = [...discoverMarketplace(dir).values()]
    if (!plugins.length) {
      console.log(`no plugins found in ${url}`)
      return
    }
    console.log(`${plugins.length} plugin(s) would be installed from ${name}:`)
    for (const plugin of plugins) reportAdded(name, [plugin])
  } finally {
    if (dir !== url) rmSync(dir, { recursive: true, force: true })
  }
}

