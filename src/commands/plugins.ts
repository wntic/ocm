import { existsSync, mkdtempSync, readlinkSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OPENCODE_AGENTS_DIR, OPENCODE_COMMANDS_DIR } from "../paths"
import { loadRegistry, loadRegistryForWrite, saveRegistry } from "../registry"
import { componentRoot, materializeLinks } from "../install"
import { discoverMarketplace } from "../discovery"
import { clone } from "../git"
import { isGitUrl, parseSource } from "../source"
import { reportRestart, reportWarnings, reportUpgrade } from "./marketplace"
import type { MarketplaceEntry, Registry } from "../types"

interface ResolvedPlugin {
  marketplace: string
  plugin: string
  entry: MarketplaceEntry
}

// spec 05 argument resolution, shared by every verb that takes a plugin
function resolvePlugin(registry: Registry, arg: string): ResolvedPlugin {
  const at = arg.indexOf("@")
  let marketplace: string | undefined
  let plugin: string
  if (at !== -1) {
    plugin = arg.slice(0, at)
    marketplace = arg.slice(at + 1)
    if (!plugin) throw new Error(`missing plugin name in "${arg}" (ocm list --all)`)
    if (!marketplace) throw new Error(`missing marketplace name in "${arg}" (ocm list)`)
  } else {
    plugin = arg
    const providers = Object.entries(registry.marketplaces).filter(([, entry]) => entry.plugins[plugin])
    if (!providers.length) {
      throw new Error(`plugin "${plugin}" not found in any marketplace (ocm add <url|path>, or ocm update)`)
    }
    if (providers.length > 1) {
      const names = providers.map(([name]) => name).join(", ")
      throw new Error(`plugin "${plugin}" is provided by more than one marketplace: ${names} (use ${plugin}@<marketplace>)`)
    }
    marketplace = providers[0]![0]
  }
  const entry = registry.marketplaces[marketplace]
  if (!entry) throw new Error(`marketplace "${marketplace}" not found (ocm list)`)
  const record = entry.plugins[plugin]
  if (!record) throw new Error(`plugin "${plugin}" not found in marketplace "${marketplace}" (ocm list --all)`)
  if (!existsSync(join(componentRoot(entry), record.source))) {
    throw new Error(`plugin "${plugin}" is registered but missing on disk in marketplace "${marketplace}" (run ocm update ${marketplace})`)
  }
  return { marketplace, plugin, entry }
}

function componentSummary(components: Partial<Record<string, string[]>>): string {
  const parts: string[] = []
  for (const [type, files] of Object.entries(components)) {
    if (files?.length) parts.push(`${files.length} ${type}${files.length === 1 ? "" : "s"}`)
  }
  return parts.join(", ")
}

export function install(arg: string, force = false): void {
  const { registry, wasV1 } = loadRegistryForWrite()
  const { marketplace, plugin, entry } = resolvePlugin(registry, arg)
  const record = entry.plugins[plugin]!
  if (!(record.enabled && record.installedAt)) {
    record.enabled = true
    record.installedAt = new Date().toISOString()
    saveRegistry(registry)
    reportUpgrade(wasV1)
  }
  const links = materializeLinks(marketplace, entry, force)
  reportWarnings(links.warnings)
  console.log(`installed ${plugin}@${marketplace} (${componentSummary(record.components)})`)
  reportRestart(links.created)
}

export function uninstall(arg: string): void {
  const { registry, wasV1 } = loadRegistryForWrite()
  const { marketplace, plugin, entry } = resolvePlugin(registry, arg)
  const record = entry.plugins[plugin]!
  if (record.enabled || record.installedAt !== null) {
    record.enabled = false
    record.installedAt = null
    saveRegistry(registry)
    reportUpgrade(wasV1)
  }
  const links = materializeLinks(marketplace, entry)
  reportWarnings(links.warnings)
  reportRestart(links.removed)
  console.log(`uninstalled ${plugin}@${marketplace}`)
}

export function setMode(name: string, mode: string): void {
  if (mode !== "auto" && mode !== "explicit") {
    throw new Error(`unknown mode "${mode}" (expected "auto" or "explicit")`)
  }
  const { registry, wasV1 } = loadRegistryForWrite()
  const entry = registry.marketplaces[name]
  if (!entry) throw new Error(`marketplace "${name}" not found (ocm list)`)
  entry.mode = mode
  saveRegistry(registry)
  reportUpgrade(wasV1)
  console.log(`marketplace "${name}" mode: ${mode}`)
}

// a plugin arg is a bare name or name@marketplace; anything with a url
// scheme or a slash is a source
function isPluginArg(source: string): boolean {
  if (isGitUrl(source) || source.includes("/")) return false
  return /^[a-z0-9]+(-[a-z0-9]+)*(@[a-z0-9]+(-[a-z0-9]+)*)?$/.test(source)
}

export function scan(source: string): void {
  if (isPluginArg(source) && !existsSync(source)) {
    scanPlugin(source)
    return
  }
  const parsed = parseSource(source)
  let dir = parsed.url
  let temp: string | null = null
  if (parsed.isGit) {
    // scan never writes outside its temp directory (spec 05): the clone
    // lives in the os temp dir, not the marketplaces store
    temp = mkdtempSync(join(tmpdir(), "ocm-scan-"))
    console.log(`cloning ${parsed.url}...`)
    try {
      clone(parsed.url, temp, parsed.ref)
    } catch (err) {
      rmSync(temp, { recursive: true, force: true })
      throw err
    }
    dir = parsed.subdir ? join(temp, parsed.subdir) : temp
  }
  try {
    const plugins = [...discoverMarketplace(dir).values()]
    if (!plugins.length) {
      console.log(`no plugins found in ${source}`)
      return
    }
    console.log(`${plugins.length} plugin(s) would be installed from ${parsed.url}:`)
    for (const plugin of plugins) {
      console.log(`  ${plugin.name} (${componentSummary(plugin.components)})`)
    }
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true })
  }
}

function scanPlugin(arg: string): void {
  const registry = loadRegistry()
  const { marketplace, plugin, entry } = resolvePlugin(registry, arg)
  const record = entry.plugins[plugin]!
  console.log(`installing ${plugin}@${marketplace} would materialize:`)
  for (const file of record.components.command ?? []) {
    reportScanDest(join(OPENCODE_COMMANDS_DIR, `${plugin}:${file}`), entry.dir)
  }
  for (const file of record.components.agent ?? []) {
    reportScanDest(join(OPENCODE_AGENTS_DIR, `${plugin}:${file}`), entry.dir)
  }
  for (const rel of record.components.skill ?? []) {
    console.log(`  skill ${plugin}:${rel}`)
  }
}

// a dest that exists but is not a symlink into this marketplace is a
// collision install would refuse (or --force displace)
function reportScanDest(dest: string, marketplaceDir: string): void {
  let target
  try {
    target = readlinkSync(dest)
  } catch {}
  const owned = target !== undefined && (target === marketplaceDir || target.startsWith(`${marketplaceDir}/`))
  console.log(`  ${dest}${owned ? "" : " (collision: install would refuse without --force)"}`)
}
