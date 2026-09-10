import { existsSync, mkdtempSync, readlinkSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isGitUrl, parseSource, resolvePlugin, setEnabled } from "../../loader/core.js"
import type { CorePluginComponents } from "../../loader/core.js"
import { OPENCODE_AGENTS_DIR, OPENCODE_COMMANDS_DIR, OPENCODE_GLOBAL_CONFIG, OPENCODE_PLUGINS_DIR } from "../paths"
import { loadRegistry, loadRegistryForWrite, saveRegistry } from "../registry"
import { discoverMarketplace } from "../discovery"
import { clone } from "../git"
import { reportRestart, reportUpgrade, reportWarnings } from "../report"

function componentSummary(components: CorePluginComponents): string {
  const parts: string[] = []
  for (const [type, files] of Object.entries(components)) {
    if (files?.length) parts.push(`${files.length} ${type}${files.length === 1 ? "" : "s"}`)
  }
  return parts.join(", ")
}

// spec 05 install: the core flips the record, saves and materializes; the
// CLI renders — disagreement first, then the upgrade, then the links report
export function install(arg: string, force = false): void {
  const result = setEnabled(arg, true, { force })
  if (result.disagreement) reportWarnings([result.disagreement])
  reportUpgrade(result.wasV1)
  reportWarnings(result.report.warnings)
  console.log(`installed ${result.plugin}@${result.marketplace} (${componentSummary(result.components)})`)
  reportRestart(result.report.created)
}

export function uninstall(arg: string): void {
  const result = setEnabled(arg, false)
  reportUpgrade(result.wasV1)
  reportWarnings(result.report.warnings)
  reportRestart(result.report.removed)
  console.log(`uninstalled ${result.plugin}@${result.marketplace}`)
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
    const discovered = discoverMarketplace(dir)
    reportWarnings(discovered.warnings)
    const plugins = [...discovered.plugins.values()]
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
  const { marketplace, plugin, entry } = resolvePlugin(loadRegistry(), arg)
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
  for (const file of record.components.plugin ?? []) {
    console.log(`  plugin ${join(OPENCODE_PLUGINS_DIR, `ocm--${plugin}--${file}`)}`)
  }
  for (const server of record.components.mcp ?? []) {
    console.log(`  mcp ocm--${plugin}--${server} (${OPENCODE_GLOBAL_CONFIG})`)
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
