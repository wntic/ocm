import { relative } from "node:path"
import { git } from "../git"
import type { DiscoveredPlugin, MarketplaceEntry, MarketplacePlugin } from "../types"

export interface FileChange {
  mark: "+" | "~" | "-"
  path: string
}

export interface PluginReport {
  name: string
  fresh: boolean
  from: string | null
  to: string | null
  files: FileChange[]
  note: string | null
}

export interface MarketplaceReport {
  name: string
  ok: boolean
  error: string | null
  note: string | null
  before: string | null
  after: string | null
  changed: boolean
  renamed: { from: string; to: string }[]
  removed: string[]
  pruned: string[]
  refused: { from: string; to: string; incumbent: string }[]
  plugins: PluginReport[]
  warnings: string[]
  materialized: { created: number; removed: number; skipped: number } | null
}

// spec 08: the per-plugin file list is git's own answer — diff the revision
// pair and filter to the plugin's source prefix
export function pluginFileChanges(
  entry: MarketplaceEntry,
  before: string | null,
  after: string | null,
  plugins: DiscoveredPlugin[],
): Map<string, FileChange[]> {
  const changes = new Map<string, FileChange[]>()
  if (!before || !after || before === after) return changes
  const diff = git(["diff", "--name-status", before, after], entry.dir)
  if (!diff.ok) return changes
  for (const line of diff.stdout.split("\n")) {
    const [status, ...paths] = line.split("\t")
    if (!status || !paths.length) continue
    const mark = status.startsWith("A") ? "+" : status.startsWith("D") ? "-" : "~"
    // R lines carry old and new; the new path is what ships now
    const path = paths[paths.length - 1]!
    for (const plugin of plugins) {
      const prefix = `${relative(entry.dir, plugin.dir)}/`
      if (path.startsWith(prefix)) {
        const list = changes.get(plugin.name) ?? []
        list.push({ mark, path: path.slice(prefix.length) })
        changes.set(plugin.name, list)
      }
    }
  }
  return changes
}

export function pluginReports(
  plugins: DiscoveredPlugin[],
  records: Record<string, MarketplacePlugin>,
  versions: Map<string, string | null>,
  known: Set<string>,
  files: Map<string, FileChange[]>,
): PluginReport[] {
  const reports: PluginReport[] = []
  for (const plugin of plugins) {
    const record = records[plugin.name]
    if (!record) continue
    const from = versions.get(plugin.name) ?? null
    const fresh = !known.has(plugin.name)
    const pluginFiles = files.get(plugin.name) ?? []
    if (!fresh && from === record.version && !pluginFiles.length) continue
    const note = record.collision
      ? `not installed (name provided by ${record.collision})`
      : fresh
        ? "installed (auto)"
        : null
    reports.push({ name: plugin.name, fresh, from, to: record.version, files: pluginFiles, note })
  }
  return reports
}

export function renderMarketplace(report: MarketplaceReport, quiet: boolean): void {
  if (quiet && report.ok && !report.changed) return
  console.log(`updating ${report.name}...`)
  for (const warning of report.warnings) console.error(`  warning: ${warning}`)
  if (report.note) {
    console.error(`marketplace "${report.name}" ${report.note}`)
    return
  }
  if (!report.ok) {
    console.error(`  failed: ${report.error}`)
    return
  }
  if (report.before && report.after) {
    console.log(report.before === report.after ? "  already up to date" : `  ${report.before.slice(0, 7)} → ${report.after.slice(0, 7)}`)
  } else if (report.materialized) {
    // no revision pair (local marketplace, re-clone): the materializer's own
    // counts are the report (spec 08)
    const m = report.materialized
    console.log(`  ${m.created} created, ${m.removed} removed, ${m.skipped} skipped`)
  }
  for (const rename of report.renamed) console.log(`  renamed ${rename.from} → ${rename.to}`)
  for (const name of report.removed) console.log(`  removed ${name}`)
  for (const name of report.pruned) console.log(`  ${name} removed (no longer in the marketplace)`)
  for (const refusal of report.refused) {
    console.log(`  refused rename ${refusal.from} → ${refusal.to}: "${refusal.to}" is already provided by marketplace "${refusal.incumbent}"`)
  }
  for (const plugin of report.plugins) {
    const detail = plugin.note ?? (plugin.from === plugin.to ? null : `${plugin.from ?? "?"} → ${plugin.to ?? "?"}`)
    console.log(`  ${plugin.name}${detail ? `   ${detail}` : ""}`)
    for (const file of plugin.files) console.log(`    ${file.mark} ${file.path}`)
  }
  if (report.materialized && report.materialized.created > 0) console.log("  restart opencode to activate")
}
