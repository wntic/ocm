import { relative } from "node:path"
import { git } from "../git"
import { outcomesNeedRestart, queueFact, reportMutationWarnings } from "../report"
import { componentRoot, digestChanges } from "../../loader/core.js"
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

// brief 33 §3 (F92): a pre-existing record's collision before and after the
// registration rebuild — an event of the update, not a registry detail
export interface CollisionTransition {
  plugin: string
  incumbent: string
  state: "recorded" | "cleared"
  // brief 33 §3: the post-rebuild enabled state — a cleared record the
  // rebuild re-enabled gets a truthful tail, not the install remedy
  enabled: boolean
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
  // brief 33 §3 (F92): collision transitions across the registration
  collisions: CollisionTransition[]
  plugins: PluginReport[]
  warnings: string[]
  outcomes: CoreOutcome[] | null
  // brief 30 §4: local plugins whose recorded digests were absent this pass —
  // unknown, not unchanged; null when the digest comparison never ran (git)
  digestsAbsent: string[] | null
  // brief 32 §4 (F97): the re-clone event line, null unless this pass
  // re-cloned
  recloned: string | null
}

// spec 08: the per-plugin file list is git's own answer — diff the revision
// pair and filter to the plugin's source prefix. Brief 31 §3: the diff also
// yields the changed set (component-root-relative, ancestors included — a
// skill matches on its source directory), which the materializer turns into
// `refreshed` outcomes. Brief 30 §1: a local marketplace has no revision
// pair — the recorded digests answer behind the same signature
export function pluginFileChanges(
  entry: MarketplaceEntry,
  before: string | null,
  after: string | null,
  plugins: DiscoveredPlugin[],
): { changes: Map<string, FileChange[]>; paths: Set<string> | null; digestsAbsent: string[] | null } {
  const changes = new Map<string, FileChange[]>()
  if (entry.local === true) return localFileChanges(entry, plugins)
  if (!before || !after || before === after) return { changes, paths: null, digestsAbsent: null }
  const diff = git(["diff", "--name-status", before, after], entry.dir)
  if (!diff.ok) return { changes, paths: null, digestsAbsent: null }
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
  return { changes, paths, digestsAbsent: null }
}

// brief 30 §2 §4: a local marketplace's changed-set — the record's digests
// diffed against the current ones, keyed by plugin-relative path. A record
// without digests is unknown, never an empty previous state, so it cannot
// render as a change flood or end a grandfather; a plugin with no record
// (fresh, or renamed a moment ago) is simply not compared
function localFileChanges(
  entry: MarketplaceEntry,
  plugins: DiscoveredPlugin[],
): { changes: Map<string, FileChange[]>; paths: Set<string>; digestsAbsent: string[] } {
  const changes = new Map<string, FileChange[]>()
  const paths = new Set<string>()
  const digestsAbsent: string[] = []
  const root = componentRoot(entry)
  for (const plugin of plugins) {
    const record = entry.plugins[plugin.name]
    if (!record) continue
    if (!record.hashes) {
      digestsAbsent.push(plugin.name)
      continue
    }
    const list: FileChange[] = digestChanges(record.hashes, plugin)
    if (!list.length) continue
    changes.set(plugin.name, list)
    // the git path's shape: component-root-relative with all ancestors, so
    // the materializer promotes a changed component to `refreshed` and a
    // skill matches on its source directory
    const prefix = relative(root, plugin.dir)
    for (const change of list) {
      const parts = `${prefix}/${change.path}`.split("/")
      for (let i = 1; i <= parts.length; i++) paths.add(parts.slice(0, i).join("/"))
    }
  }
  return { changes, paths, digestsAbsent }
}

// brief 31 §3: a diff path joins an outcome by the outcome's source — exact
// for a file component, by directory for a skill. A removed outcome carries
// no source, so its candidates are reconstructed from the component name
// under both directory spellings
function outcomeMatches(outcome: CoreOutcome, pluginDir: string, path: string): boolean {
  if (outcome.type === "mcp") return false
  if (outcome.source !== null) {
    const rel = relative(pluginDir, outcome.source)
    // brief 30 §2: a local digest keys a skill by its directory, the git
    // diff by the files inside it — both match here
    return outcome.type === "skill" ? path === rel || path.startsWith(`${rel}/`) : path === rel
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

// spec 08: with no revision pair the materializer's own counts are the
// report; an all-zero line says nothing (spec 23 §7). Brief 30 §4 keeps them
// as the fallback for a re-clone and for a local pass whose recorded digests
// were absent
function renderOutcomeCounts(report: MarketplaceReport): void {
  const counts = { created: 0, removed: 0, skipped: 0 }
  for (const outcome of report.outcomes ?? []) {
    if (outcome.state === "created") counts.created += 1
    else if (outcome.state === "removed") counts.removed += 1
    else if (outcome.state !== "current" && outcome.state !== "refreshed") counts.skipped += 1
  }
  if (counts.created || counts.removed || counts.skipped) {
    console.log(`  ${counts.created} created, ${counts.removed} removed, ${counts.skipped} skipped`)
  }
}

// brief 48 §1 (F258): a reverted user edit is a change the revision pair
// cannot see — the warning is the event
const REVERTED_EDIT_PREFIX = "reverted your edits to "

export function revertedEdits(report: MarketplaceReport): boolean {
  return report.warnings.some((w) => w.startsWith(REVERTED_EDIT_PREFIX))
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
  if (report.recloned) console.log(report.recloned)
  if (!report.ok) {
    console.error(`  failed: ${report.error}`)
    return
  }
  if (report.before && report.after) {
    // brief 48 §1 (F258): a reverted user edit on an unmoved revision says
    // nothing here — the stderr warning is the event
    if (report.before !== report.after) console.log(`  ${report.before.slice(0, 7)} → ${report.after.slice(0, 7)}`)
    else if (!revertedEdits(report)) console.log("  already up to date")
  } else if (report.digestsAbsent !== null) {
    // brief 30 §4: a local marketplace has no revision pair — the recorded
    // digests answer, and an absent baseline is unknown, never unchanged
    if (report.digestsAbsent.length > 0) {
      console.log("  change tracking initialized — this pass reports no per-plugin changes")
      renderOutcomeCounts(report)
    } else if (!report.changed) {
      console.log("  already up to date")
    }
  } else if (report.outcomes?.length) {
    renderOutcomeCounts(report)
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
  // brief 33 §3 (F92): one line per collision transition, both directions —
  // a cleared name the rebuild re-enabled says so rather than naming an
  // install the very same run just performed
  for (const collision of report.collisions) {
    console.log(
      collision.state === "recorded"
        ? `  ${collision.plugin}: name taken over by marketplace "${collision.incumbent}" — kept disabled; ocm install ${collision.plugin}@${report.name} --force to take it back`
        : collision.enabled
          ? `  ${collision.plugin}: the name is free again — re-enabled`
          : `  ${collision.plugin}: the name is free again — ocm install ${collision.plugin}@${report.name} to enable it`,
    )
  }
  for (const plugin of report.plugins) {
    const detail = versionDetail(plugin, report.name)
    console.log(`  ${plugin.name}${detail ? `   ${detail}` : ""}`)
    for (const file of plugin.files) {
      console.log(file.mark === "!" ? `    ${file.mark} ${file.path} — ${file.reason}` : `    ${file.mark} ${file.path}`)
    }
  }
  // spec 23 §5: anything created, removed or refreshed needs a restart — a
  // removal leaves the stale command live until then, and nothing reloads
  // in-session
  if (outcomesNeedRestart(report.outcomes)) {
    console.log("  restart opencode to activate")
  }
}
