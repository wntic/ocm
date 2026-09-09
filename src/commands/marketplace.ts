import { existsSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { OCM_MARKETPLACES_DIR, OCM_REGISTRY_FILE, marketplaceDir, marketplaceNameFromUrl } from "../paths"
import { loadRegistry, loadRegistryForWrite, saveRegistry } from "../registry"
import { materializeLinks, removeLinks, registerPlugins } from "../install"
import { clone } from "../git"
import { pullRepo } from "../../loader/core.js"
import { discoverMarketplace } from "../discovery"
import type { DiscoveredPlugin } from "../discovery"
import type { MarketplaceEntry } from "../types"
import { installLoader } from "../loader"

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

function reportWarnings(warnings: string[]): void {
  for (const warning of warnings) console.error(`  warning: ${warning}`)
}

function reportRestart(created: number): void {
  if (created > 0) console.log("restart opencode to activate")
}

function reportUpgrade(wasV1: boolean): void {
  if (wasV1) console.log(`registry upgraded v1 → v2 (${OCM_REGISTRY_FILE})`)
}

export function add(source: string): void {
  const { url, name } = parseSource(source)
  const { registry, wasV1 } = loadRegistryForWrite()

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
      dir: url,
      local: true,
      addedAt: new Date().toISOString(),
      mode: "auto",
      ref: null,
      revision: null,
      syncIntervalMs: null,
      trust: { code: "none" },
      lastSync: null,
      plugins: {},
    }
    const plugins = [...discoverMarketplace(url).values()]
    const entry = registry.marketplaces[name]!
    registerPlugins(entry, plugins)
    const links = materializeLinks(name, url, entry)
    reportWarnings(links.warnings)
    reportRestart(links.created)
    saveRegistry(registry)
    reportUpgrade(wasV1)
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
    dir,
    local: false,
    addedAt: new Date().toISOString(),
    mode: "auto",
    ref: null,
    revision: null,
    syncIntervalMs: null,
    trust: { code: "none" },
    lastSync: null,
    plugins: {},
  }
  registry.marketplaces[name] = entry
  registerPlugins(entry, plugins)
  const links = materializeLinks(name, dir, entry)
  reportWarnings(links.warnings)
  reportRestart(links.created)
  installLoader()
  saveRegistry(registry)
  reportUpgrade(wasV1)
  reportAdded(name, plugins)
}

function reportAdded(name: string, plugins: DiscoveredPlugin[]): void {
  console.log(`added marketplace "${name}"`)
  for (const plugin of plugins) {
    const parts: string[] = []
    if (plugin.components.agent) parts.push(`${plugin.components.agent.length} agents`)
    if (plugin.components.command) parts.push(`${plugin.components.command.length} commands`)
    if (plugin.components.skill) parts.push(`${plugin.components.skill.length} skills`)
    console.log(`  ${plugin.name} (${parts.join(", ")})`)
  }
  console.log("commands and agents are available as /<plugin>:<name> in every project")
}

export function remove(name: string): void {
  const { registry, wasV1 } = loadRegistryForWrite()
  const entry = registry.marketplaces[name]
  if (!entry) {
    throw new Error(`marketplace "${name}" not found (ocm list)`)
  }
  removeLinks(name, entry.dir)
  // `local === false` rather than `!local`: an entry missing the field must
  // never be treated as ocm-managed and deleted
  if (entry.local === false) {
    rmSync(entry.dir, { recursive: true, force: true })
  }
  delete registry.marketplaces[name]
  saveRegistry(registry)
  reportUpgrade(wasV1)
  console.log(`removed marketplace "${name}"`)
}

export async function update(name?: string): Promise<void> {
  const { registry, wasV1 } = loadRegistryForWrite()
  const names = name ? [name] : Object.keys(registry.marketplaces)
  if (!names.length) {
    console.log("no marketplaces added yet (ocm add <url|path>)")
    return
  }
  let reinstalledLoader = false
  for (const marketplaceName of names) {
    const entry = registry.marketplaces[marketplaceName]
    if (!entry) {
      console.error(`marketplace "${marketplaceName}" not found, skipping`)
      continue
    }
    if (!existsSync(entry.dir)) {
      console.error(`marketplace "${marketplaceName}" directory missing (${entry.dir}), skipping`)
      continue
    }
    if (entry.local === false) {
      console.log(`updating ${marketplaceName}...`)
      const result = await pullRepo(entry.dir)
      if (!result.ok) {
        console.error(`  failed: ${result.output}`)
        continue
      }
      console.log(`  ${result.changed ? "updated to new revision" : "already up to date"}`)
    } else {
      console.log(`${marketplaceName} is local (${entry.url}), refreshing links`)
    }
    const plugins = [...discoverMarketplace(entry.dir).values()]
    registerPlugins(entry, plugins)
    const links = materializeLinks(marketplaceName, entry.dir, entry)
    reportWarnings(links.warnings)
    reportRestart(links.created)
    if (!reinstalledLoader) {
      installLoader()
      reinstalledLoader = true
    }
  }
  saveRegistry(registry)
  reportUpgrade(wasV1)
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
