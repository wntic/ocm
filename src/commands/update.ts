import { existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { errorMessage, pullRepo, readRenames, reconcilePluginRecords, registerPlugins, resolveChains } from "../../loader/core.js"
import { componentRoot, deriveComponents, materializeLinks, removeMcpKeys } from "../install"
import { discoverMarketplace } from "../discovery"
import { clone, git, requireGit } from "../git"
import { loadRegistryForWrite, saveRegistry, saveRegistryIfChanged } from "../registry"
import { installLoader, reportTuiPlugin } from "../loader"
import { reportUpgrade } from "../report"
import type { DiscoveredPlugin, MarketplaceEntry, Registry } from "../types"
import { decideUpdateTrust } from "./trust"
import { pluginFileChanges, pluginReports, renderMarketplace } from "./update-report"
import type { FileChange, MarketplaceReport } from "./update-report"

export interface UpdateOptions {
  quiet?: boolean
  json?: boolean
  trust?: boolean
}

// `ocm update` takes a marketplace or nothing; a bare name that is not one
// is looked up as a plugin so the error names where it lives
function resolveTarget(registry: Registry, target?: string): { names: string[] } {
  if (!target) return { names: Object.keys(registry.marketplaces) }
  if (target.includes("@")) {
    throw new Error(`ocm update takes a marketplace, not a plugin — run \`ocm update ${target.slice(target.indexOf("@") + 1)}\``)
  }
  if (registry.marketplaces[target]) return { names: [target] }
  const providers = Object.keys(registry.marketplaces).filter((name) =>
    Object.hasOwn(registry.marketplaces[name]!.plugins, target),
  )
  if (providers.length === 1) {
    const mp = providers[0]!
    throw new Error(`"${target}" is a plugin in marketplace "${mp}" — run \`ocm update ${mp}\``)
  }
  if (providers.length > 1) {
    const listed = providers.map((mp) => `"${mp}"`).join(" and ")
    const commands = providers.map((mp) => `\`ocm update ${mp}\``).join(" or ")
    throw new Error(`"${target}" is a plugin in marketplaces ${listed} — run ${commands}`)
  }
  throw new Error(`marketplace "${target}" not found (ocm list)`)
}

export async function update(target?: string, options: UpdateOptions = {}): Promise<void> {
  const { registry, wasV1 } = loadRegistryForWrite()
  const { names } = resolveTarget(registry, target)
  if (!names.length) {
    if (options.json) console.log(JSON.stringify({ marketplaces: [] }, null, 2))
    else console.log("no marketplaces added yet (ocm add <url|path>)")
    return
  }
  const reports: MarketplaceReport[] = []
  // brief 32 §1: git is probed once, before the first pull — git off PATH
  // stops the run once instead of failing every marketplace
  if (names.some((name) => !registry.marketplaces[name]!.local)) requireGit()
  // before any prompt: the loader files do not depend on the trust decision,
  // so an interrupt at a re-prompt cannot skip them (spec 16). A no-op
  // reports nothing for the loader (spec 23 §2); the TUI line is a notice
  // and waits for the headers (spec 23 §6)
  const tuiInstalled = installLoader(false)
  for (const name of names) {
    // spec 23 §6: the header opens the marketplace's section before any of
    // its output — the trust block included
    if (!options.json && !options.quiet) console.log(`updating ${name}...`)
    const report = await updateOne(registry, name, options.trust)
    reports.push(report)
    if (!options.json) renderMarketplace(report, options.quiet === true, !options.quiet)
  }
  if (options.json) console.log(JSON.stringify({ marketplaces: reports }, null, 2))
  if (tuiInstalled) reportTuiPlugin()
  reportUpgrade(wasV1)
  const failed = reports.filter((report) => !report.ok).map((report) => report.name)
  if (failed.length) {
    throw new Error(`update failed for ${failed.length} marketplace(s): ${failed.join(", ")}`)
  }
}

// spec 20: the re-clone behind both `ocm update` and `ocm doctor --fix` —
// one code path, so a missing cache is repaired the same way everywhere
export function recloneMarketplace(entry: MarketplaceEntry): { revision: string; event: string } {
  if (!entry.url) throw new Error(`clone directory missing (${entry.dir}) and no url recorded; remove and re-add the marketplace`)
  mkdirSync(dirname(entry.dir), { recursive: true })
  clone(entry.url, entry.dir, entry.ref)
  // spec 23 §7: an event of the report, not a warning
  return {
    revision: git(["rev-parse", "HEAD"], entry.dir).stdout,
    event: `clone directory missing, re-clone from ${entry.url}...`,
  }
}

// pull, or re-clone a cleared cache (spec 08 edge cases); the revision
// pair and the re-clone note land on the report
async function pullMarketplace(entry: MarketplaceEntry, name: string, report: MarketplaceReport): Promise<void> {
  if (entry.local) {
    // a local directory is the user's: reported and skipped, never re-created
    if (!existsSync(entry.dir)) report.note = `directory missing (${entry.dir}), skipping`
  } else if (existsSync(entry.dir)) {
    const pull = await pullRepo(entry, name)
    if (!pull.ok) throw new Error(pull.output)
    report.before = pull.before
    report.after = pull.after
    // spec 26: warn only when something was dirty, naming the counts — the
    // remedy (reset + clean) makes "discarded" true
    const discarded = []
    if (pull.localChanges > 0) discarded.push(`${pull.localChanges} local change${pull.localChanges === 1 ? "" : "s"}`)
    if (pull.untracked > 0) discarded.push(`${pull.untracked} untracked file${pull.untracked === 1 ? "" : "s"}`)
    if (discarded.length > 0) {
      // brief 32 §4 (F99): the paths sit beneath the count sentence — git
      // clean -fd makes them unrecoverable after the fact
      const lines = [`${entry.dir} has local changes; discarded ${discarded.join(" and ")} (the cache is not an editing surface)`]
      for (const path of pull.paths.slice(0, 10)) lines.push(`    ${path}`)
      if (pull.paths.length > 10) lines.push(`    … and ${pull.paths.length - 10} more`)
      report.warnings.push(lines.join("\n"))
    }
  } else {
    const { revision, event } = recloneMarketplace(entry)
    report.after = revision
    report.recloned = event
  }
}

// one marketplace, wrapped: a failure records lastSync.ok = false and moves
// on, never touching this marketplace's links (spec 08)
async function updateOne(registry: Registry, name: string, trust?: boolean): Promise<MarketplaceReport> {
  const entry = registry.marketplaces[name]!
  const report: MarketplaceReport = {
    name, ok: true, error: null, note: null, before: null, after: null, changed: false,
    renamed: [], removed: [], pruned: [], dropped: [], refused: [], plugins: [], warnings: [], outcomes: null,
    digestsAbsent: null, recloned: null,
  }
  try {
    await pullMarketplace(entry, name, report)
    if (!report.note) {
      const views = reconcile(registry, name, report)
      await decideUpdateTrust(name, entry, componentRoot(entry), trust)
      if (report.after) entry.revision = report.after
      entry.lastSync = { at: new Date().toISOString(), ok: true, error: null }
      saveRegistry(registry)
      const links = materializeLinks(name, entry, false, views.paths)
      report.warnings.push(...links.warnings)
      // brief 31 §3: the records are derived from what materialized, then
      // saved again — two writes, one lock (spec 27 §1)
      deriveComponents(registry, name, links.outcomes)
      // brief 31 §5: a kept record survives unless this run removed its
      // components and the record is not disabled — a disabled record was
      // already the user's decision, so it stays
      for (const refusal of report.refused) {
        const record = entry.plugins[refusal.from]
        if (!record) continue
        refusal.held =
          record.enabled === false ||
          links.outcomes.some((o) =>
            o.plugin === refusal.from && (o.state === "created" || o.state === "current" || o.state === "refreshed")
          )
        if (!refusal.held) delete entry.plugins[refusal.from]
      }
      saveRegistryIfChanged(registry)
      report.outcomes = links.outcomes
      // brief 31 §5: one line per plugin naming its net outcome, derived
      // from the outcomes plus the record transition
      for (const refusal of report.refused) {
        refusal.components = links.outcomes
          .filter((o) => o.plugin === refusal.from && o.state === "removed")
          .map((o) => `${o.type} ${o.plugin}:${o.component}`)
      }
      for (const rename of report.renamed) {
        const record = entry.plugins[rename.to]
        const materialized = links.outcomes.some((o) =>
          o.plugin === rename.to && (o.state === "created" || o.state === "current" || o.state === "refreshed")
        )
        if (record && materialized) {
          rename.net = "renamed"
          rename.reason = null
        } else if (record) {
          rename.net = "not-installed"
          const withheld = links.outcomes.find(
            (o) => o.plugin === rename.to && (o.state === "skipped" || o.state === "blocked" || o.state === "refused"),
          )
          rename.reason = withheld?.reason ?? (record.enabled === false ? "disabled" : "not installed")
        } else {
          rename.net = "removed"
          rename.reason = report.dropped.find((drop) => drop.name === rename.to)?.reason ?? "uninstalled"
        }
      }
      report.plugins = pluginReports(views.plugins, entry.plugins, views.versions, views.known, views.changes, name, entry.mode, links.outcomes)
      report.changed =
        report.before !== report.after ||
        report.renamed.length > 0 ||
        report.removed.length > 0 ||
        report.pruned.length > 0 ||
        report.dropped.length > 0 ||
        report.refused.length > 0 ||
        report.plugins.length > 0 ||
        links.outcomes.some((o) => o.state === "created")
    }
  } catch (err) {
    report.ok = false
    report.error = errorMessage(err)
    entry.lastSync = { at: new Date().toISOString(), ok: false, error: report.error }
    try {
      saveRegistry(registry)
    } catch {}
  }
  return report
}

// what reconcile computed for updateOne's report: the discovered plugins,
// the pre-registration record snapshots, and the git-diff views (the
// per-plugin file lists and the changed set the materializer turns into
// `refreshed`)
interface ReconcileViews {
  plugins: DiscoveredPlugin[]
  versions: Map<string, string | null>
  known: Set<string>
  changes: Map<string, FileChange[]>
  paths: Set<string> | null
}

// discover, reconcile against the registry (spec 08 step 4); the record
// reconciliation itself — renames, refusals, prune — is the core's shared
// function (spec 20)
function reconcile(registry: Registry, name: string, report: MarketplaceReport): ReconcileViews {
  const entry = registry.marketplaces[name]!
  const root = componentRoot(entry)
  const discovered = discoverMarketplace(root)
  report.warnings.push(...discovered.warnings)
  const plugins = [...discovered.plugins.values()]
  const renames = readRenames(root, plugins)
  const { resolved, cycles } = resolveChains(renames)
  for (const cycle of cycles) report.warnings.push(`rename cycle ignored: ${cycle.join(" → ")} → ${cycle[0]}`)
  // brief 30 §3: the digest comparison must run before
  // reconcilePluginRecords/registerPlugins — registration re-baselines a
  // local record's hashes (loader/marketplace.js), so after it the diff
  // would always be empty. It also sees the records pre-rename, so a
  // renamed plugin's new name has no record yet and holds its grandfather
  const fileViews = pluginFileChanges(entry, report.before, report.after, plugins)
  report.digestsAbsent = fileViews.digestsAbsent
  const changed = new Set([...fileViews.changes].filter(([, files]) => files.length > 0).map(([pluginName]) => pluginName))
  const { warnings, pruned, dropped, renamed, removed, refused, kept, registrable } = reconcilePluginRecords(registry, name, root, {
    discovered: plugins, resolved, changed,
  })
  // snapshotted after the reconcile — a migrated record sits under its new
  // name — and before registration, so a new plugin is not yet known
  const versions = new Map(Object.entries(entry.plugins).map(([pluginName, plugin]) => [pluginName, plugin.version]))
  const known = new Set(Object.keys(entry.plugins))
  registerPlugins(registry, name, registrable)
  // registration replaces the plugins map wholesale, so the records a
  // refused rename kept go back after it
  Object.assign(entry.plugins, kept)
  const mcp = removeMcpKeys([...removed, ...renamed.map((rename) => rename.from), ...pruned])
  if (mcp.warning) report.warnings.push(mcp.warning)
  report.warnings.push(...warnings)
  report.renamed = renamed.map((rename) => ({ ...rename, net: "renamed" as const, reason: null }))
  report.removed = removed
  report.pruned = pruned
  report.dropped = dropped
  report.refused = refused.map(({ from, to, incumbent }) => ({ from, to, incumbent, held: true, components: [] }))
  return { plugins, versions, known, changes: fileViews.changes, paths: fileViews.paths }
}
