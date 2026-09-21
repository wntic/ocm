import { relative } from "node:path"
import { git } from "../git"
import { queueFact, reportMutationWarnings } from "../report"
import type { CoreOutcome } from "../../loader/core.js"
import type { DiscoveredPlugin, MarketplaceEntry, MarketplacePlugin } from "../types"

export interface FileChange {
  mark: "+" | "~" | "-" | "!"
  path: string
  // brief 31 §3: a withheld component carries its outcome's reason after an em dash
  reason?: string
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
  // brief 31 §5: net is derived from the outcomes plus the record
  // transition, not from the step that happened to run first
  renamed: { from: string; to: string; net: "renamed" | "not-installed" | "removed"; reason: string | null }[]
  removed: string[]
  pruned: string[]
  dropped: { name: string; reason: string }[]
  refused: { from: string; to: string; incumbent: string; held: boolean; components: string[] }[]
  plugins: PluginReport[]
  warnings: string[]
  outcomes: CoreOutcome[] | null
}

// spec 08: the per-plugin file list is git's own answer — diff the revision
// pair and filter to the plugin's source prefix. Brief 31 §3: the diff also
// yields the changed set (component-root-relative, ancestors included — a
// skill matches on its source directory), which the materializer turns into
// `refreshed` outcomes
export function pluginFileChanges(
  entry: MarketplaceEntry,
  before: string | null,
  after: string | null,
  plugins: DiscoveredPlugin[],
): { changes: Map<string, FileChange[]>; paths: Set<string> | null } {
  const changes = new Map<string, FileChange[]>()
  if (!before || !after || before === after) return { changes, paths: null }
  const diff = git(["diff", "--name-status", before, after], entry.dir)
  if (!diff.ok) return { changes, paths: null }
  const paths = new Set<string>()
  const subdir = entry.subdir ? `${entry.subdir}/` : ""
  for (const line of diff.stdout.split("\n")) {
    const [status, ...diffPaths] = line.split("\t")
    if (!status || !diffPaths.length) continue
    const mark = status.startsWith("A") ? "+" : status.startsWith("D") ? "-" : "~"
    // R lines carry old and new; the new path is what ships now
    const path = diffPaths[diffPaths.length - 1]!
    if (subdir && !path.startsWith(subdir)) continue
    const rel = path.slice(subdir.length)
    const parts = rel.split("/")
    for (let i = 1; i <= parts.length; i++) paths.add(parts.slice(0, i).join("/"))
    for (const plugin of plugins) {
      const prefix = `${relative(entry.dir, plugin.dir)}/`
      if (path.startsWith(prefix)) {
        const list = changes.get(plugin.name) ?? []
        list.push({ mark, path: path.slice(prefix.length) })
        changes.set(plugin.name, list)
      }
    }
  }
  return { changes, paths }
}

// brief 31 §3: a diff path joins an outcome by the outcome's source — exact
// for a file component, by directory for a skill. A removed outcome carries
// no source, so its candidates are reconstructed from the component name
// under both directory spellings
function outcomeMatches(outcome: CoreOutcome, pluginDir: string, path: string): boolean {
  if (outcome.type === "mcp") return false
  if (outcome.source !== null) {
    const rel = relative(pluginDir, outcome.source)
    return outcome.type === "skill" ? path.startsWith(`${rel}/`) : path === rel
  }
  const dirs =
    outcome.type === "command" ? ["commands", "command"]
      : outcome.type === "agent" ? ["agents", "agent"]
        : outcome.type === "skill" ? ["skills", "skill"]
          : ["plugin", "plugins"]
  return dirs.some((dir) =>
    outcome.type === "skill"
      ? path === `${dir}/${outcome.component}` || path.startsWith(`${dir}/${outcome.component}/`)
      : path === `${dir}/${outcome.component}`,
  )
}

// brief 31 §3: the printed list is the git diff intersected with the
// outcomes — a materializing outcome keeps its git mark, a withheld one
// prints `!` with its reason, and a path no outcome supports does not print
function renderFiles(files: FileChange[], outcomes: CoreOutcome[], pluginName: string, pluginDir: string): FileChange[] {
  const rendered: FileChange[] = []
  for (const change of files) {
    const outcome = outcomes.find((o) => o.plugin === pluginName && outcomeMatches(o, pluginDir, change.path))
    if (!outcome) continue
    if (outcome.state === "created" || outcome.state === "refreshed" || outcome.state === "removed") rendered.push(change)
    else if (outcome.state === "skipped" || outcome.state === "blocked" || outcome.state === "refused") {
      rendered.push({ mark: "!", path: change.path, reason: outcome.reason ?? "" })
    }
  }
  return rendered
}

export function pluginReports(
  plugins: DiscoveredPlugin[],
  records: Record<string, MarketplacePlugin>,
  versions: Map<string, string | null>,
  known: Set<string>,
  files: Map<string, FileChange[]>,
  marketplace: string,
  mode: MarketplaceEntry["mode"],
  outcomes: CoreOutcome[],
): PluginReport[] {
  const reports: PluginReport[] = []
  for (const plugin of plugins) {
    const record = records[plugin.name]
    if (!record) continue
    const from = versions.get(plugin.name) ?? null
    const fresh = !known.has(plugin.name)
    const pluginFiles = files.get(plugin.name) ?? []
    if (!fresh && from === record.version && !pluginFiles.length) continue
    // spec 23 §4: in an explicit marketplace a new upstream plugin is
    // registered disabled and nothing is created — it is available, not
    // installed, and there is no file list to print
    const available = fresh && mode === "explicit"
    // spec 18: a collision encountered during update is reported, not acted on
    const note = record.collision
      ? `name owned by marketplace "${record.collision}" — kept disabled; ocm install ${plugin.name}@${marketplace} --force to take over`
      : available
        ? `available — ocm install ${plugin.name} to activate`
        : fresh
          ? "installed (auto)"
          : null
    const rendered = available ? [] : renderFiles(pluginFiles, outcomes, plugin.name, plugin.dir)
    reports.push({ name: plugin.name, fresh, from, to: record.version, files: rendered, note })
  }
  return reports
}

// brief 31 §7 (F94): an unknown side omits the transition entirely — a
// vanished manifest is its own fact, not a version arrow
function versionDetail(plugin: PluginReport, marketplace: string): string | null {
  if (plugin.note) return plugin.note
  if (plugin.from === plugin.to) return null
  if (plugin.to === null) {
    queueFact("manifest-gone", `${marketplace}/${plugin.name}`, () => {
      console.error(`  warning: ${marketplace}/${plugin.name}: manifest gone — version unknown (was ${plugin.from})`)
    })
    return null
  }
  if (plugin.from === null) return null
  return `${plugin.from} → ${plugin.to}`
}

export function renderMarketplace(report: MarketplaceReport, quiet: boolean, headerPrinted = false): void {
  if (quiet && report.ok && !report.changed) return
  if (!headerPrinted) console.log(`updating ${report.name}...`)
  reportMutationWarnings(
    { marketplace: report.name, outcomes: report.outcomes ?? [], warnings: report.warnings },
    { marketplace: report.name },
  )
  if (report.note) {
    // spec 23 §7: an event of the report, not a warning
    console.log(`marketplace "${report.name}" ${report.note}`)
    return
  }
  if (!report.ok) {
    console.error(`  failed: ${report.error}`)
    return
  }
  if (report.before && report.after) {
    console.log(report.before === report.after ? "  already up to date" : `  ${report.before.slice(0, 7)} → ${report.after.slice(0, 7)}`)
  } else if (report.outcomes?.length) {
    // no revision pair (local marketplace, re-clone): the materializer's own
    // counts are the report (spec 08); an all-zero line says nothing (spec 23 §7)
    const counts = { created: 0, removed: 0, skipped: 0 }
    for (const outcome of report.outcomes) {
      if (outcome.state === "created") counts.created += 1
      else if (outcome.state === "removed") counts.removed += 1
      else if (outcome.state !== "current" && outcome.state !== "refreshed") counts.skipped += 1
    }
    if (counts.created || counts.removed || counts.skipped) {
      console.log(`  ${counts.created} created, ${counts.removed} removed, ${counts.skipped} skipped`)
    }
  }
  for (const rename of report.renamed) {
    if (rename.net === "renamed") console.log(`  renamed ${rename.from} → ${rename.to}`)
    else if (rename.net === "not-installed") console.log(`  renamed ${rename.from} → ${rename.to}, then not installed: ${rename.reason}`)
    else console.log(`  removed ${rename.from}: ${rename.reason}`)
  }
  for (const name of report.removed) console.log(`  removed ${name}`)
  for (const name of report.pruned) console.log(`  ${name} removed (no longer in the marketplace)`)
  // brief 31 §5: one line per plugin — a rename the gate dropped prints as
  // removed above, not again here
  const removedTargets = new Set(report.renamed.filter((rename) => rename.net === "removed").map((rename) => rename.to))
  for (const drop of report.dropped) {
    if (removedTargets.has(drop.name)) continue
    console.log(`  ${drop.name}   uninstalled — ${drop.reason}`)
  }
  for (const refusal of report.refused) {
    console.log(`  refused rename ${refusal.from} → ${refusal.to}: "${refusal.to}" is already provided by marketplace "${refusal.incumbent}"`)
    console.log(
      refusal.held
        ? `    ${refusal.from} keeps its current name and components; resolve the collision upstream or run \`ocm remove ${refusal.incumbent}\``
        : `    ${refusal.from} removed: ${refusal.components.join(", ")}`,
    )
  }
  for (const plugin of report.plugins) {
    const detail = versionDetail(plugin, report.name)
    console.log(`  ${plugin.name}${detail ? `   ${detail}` : ""}`)
    for (const file of plugin.files) {
      console.log(file.mark === "!" ? `    ${file.mark} ${file.path} — ${file.reason}` : `    ${file.mark} ${file.path}`)
    }
  }
  // spec 23 §5: anything created or removed needs a restart — a removal
  // leaves the stale command live until then
  if (report.outcomes?.some((outcome) => outcome.state === "created" || outcome.state === "removed")) {
    console.log("  restart opencode to activate")
  }
}
