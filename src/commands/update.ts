import { existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { pullRepo } from "../../loader/core.js"
import { componentRoot, materializeLinks, registerPlugins, removeMcpKeys } from "../install"
import { discoverMarketplace, readRenames } from "../discovery"
import { applyRenames, resolveChains } from "../renames"
import { clone, git } from "../git"
import { loadRegistryForWrite, saveRegistry } from "../registry"
import { installLoader } from "../loader"
import { reportUpgrade } from "../report"
import type { MarketplaceEntry, Registry } from "../types"
import { decideUpdateTrust } from "./trust"
import { pluginFileChanges, pluginReports, renderMarketplace } from "./update-report"
import type { MarketplaceReport } from "./update-report"

export interface UpdateOptions {
  quiet?: boolean
  json?: boolean
  trust?: boolean
}

// `ocm update` takes a marketplace, a plugin@marketplace, or nothing
function resolveTarget(registry: Registry, target?: string): { names: string[]; plugin?: string } {
  if (!target) return { names: Object.keys(registry.marketplaces) }
  const at = target.indexOf("@")
  if (at === -1) {
    if (!registry.marketplaces[target]) throw new Error(`marketplace "${target}" not found (ocm list)`)
    return { names: [target] }
  }
  const plugin = target.slice(0, at)
  const name = target.slice(at + 1)
  const entry = registry.marketplaces[name]
  if (!entry) throw new Error(`marketplace "${name}" not found (ocm list)`)
  if (!entry.plugins[plugin]) {
    throw new Error(`plugin "${plugin}" not found in marketplace "${name}" (ocm list --all)`)
  }
  return { names: [name], plugin }
}

export async function update(target?: string, options: UpdateOptions = {}): Promise<void> {
  const { registry, wasV1 } = loadRegistryForWrite()
  const { names, plugin } = resolveTarget(registry, target)
  if (!names.length) {
    if (options.json) console.log(JSON.stringify({ marketplaces: [] }, null, 2))
    else console.log("no marketplaces added yet (ocm add <url|path>)")
    return
  }
  const reports: MarketplaceReport[] = []
  let installedLoader = false
  for (const name of names) {
    const report = await updateOne(registry, name, options.trust, plugin)
    reports.push(report)
    if (!options.json) renderMarketplace(report, options.quiet === true)
    if (report.ok && !installedLoader) {
      installLoader()
      installedLoader = true
    }
  }
  if (options.json) console.log(JSON.stringify({ marketplaces: reports }, null, 2))
  reportUpgrade(wasV1)
  const failed = reports.filter((report) => !report.ok).map((report) => report.name)
  if (failed.length) {
    throw new Error(`update failed for ${failed.length} marketplace(s): ${failed.join(", ")}`)
  }
}

// pull, or re-clone a cleared cache (spec 08 edge cases); the revision
// pair and the re-clone note land on the report
async function pullMarketplace(entry: MarketplaceEntry, report: MarketplaceReport): Promise<void> {
  if (entry.local) {
    // a local directory is the user's: reported and skipped, never re-created
    if (!existsSync(entry.dir)) report.note = `directory missing (${entry.dir}), skipping`
  } else if (existsSync(entry.dir)) {
    const pull = await pullRepo(entry.dir, entry.ref)
    if (!pull.ok) throw new Error(pull.output)
    report.before = pull.before
    report.after = pull.after
    if (pull.dirty) report.warnings.push(`${entry.dir} has local changes; discarded (the cache is not an editing surface)`)
  } else {
    if (!entry.url) throw new Error(`clone directory missing (${entry.dir}) and no url recorded; remove and re-add the marketplace`)
    console.error(`clone directory missing, re-cloning ${entry.url}...`)
    mkdirSync(dirname(entry.dir), { recursive: true })
    clone(entry.url, entry.dir, entry.ref)
    report.after = git(["rev-parse", "HEAD"], entry.dir).stdout
  }
}

// one marketplace, wrapped: a failure records lastSync.ok = false and moves
// on, never touching this marketplace's links (spec 08)
async function updateOne(registry: Registry, name: string, trust?: boolean, plugin?: string): Promise<MarketplaceReport> {
  const entry = registry.marketplaces[name]!
  const report: MarketplaceReport = {
    name, ok: true, error: null, note: null, before: null, after: null, changed: false,
    renamed: [], removed: [], pruned: [], refused: [], plugins: [], warnings: [], materialized: null,
  }
  try {
    await pullMarketplace(entry, report)
    if (!report.note) {
      reconcile(registry, name, report, plugin)
      await decideUpdateTrust(name, entry, componentRoot(entry), trust)
      if (report.after) entry.revision = report.after
      entry.lastSync = { at: new Date().toISOString(), ok: true, error: null }
      saveRegistry(registry)
      const links = materializeLinks(name, entry, false, plugin)
      report.warnings.push(...links.warnings)
      report.materialized = { created: links.created, removed: links.removed, skipped: links.skipped }
      report.changed =
        report.before !== report.after ||
        report.renamed.length > 0 ||
        report.removed.length > 0 ||
        report.pruned.length > 0 ||
        report.refused.length > 0 ||
        report.plugins.length > 0 ||
        links.created > 0
    }
  } catch (err) {
    report.ok = false
    report.error = err instanceof Error ? err.message : String(err)
    entry.lastSync = { at: new Date().toISOString(), ok: false, error: report.error }
    try {
      saveRegistry(registry)
    } catch {}
  }
  return report
}

// discover, apply renames, reconcile against the registry (spec 08 step 4)
function reconcile(registry: Registry, name: string, report: MarketplaceReport, plugin?: string): void {
  const entry = registry.marketplaces[name]!
  const root = componentRoot(entry)
  const discovered = discoverMarketplace(root)
  report.warnings.push(...discovered.warnings)
  const plugins = [...discovered.plugins.values()]
  const renames = readRenames(root, plugins)
  const { resolved, cycles } = resolveChains(renames)
  for (const cycle of cycles) report.warnings.push(`rename cycle ignored: ${cycle.join(" → ")} → ${cycle[0]}`)
  const applied = applyRenames(registry, name, entry, discovered.plugins, resolved)
  const pruned: string[] = []
  for (const pluginName of Object.keys(entry.plugins)) {
    if (!discovered.plugins.has(pluginName) && !(pluginName in resolved)) {
      delete entry.plugins[pluginName]
      pruned.push(pluginName)
    }
  }
  removeMcpKeys([...applied.removed, ...applied.renamed.map((rename) => rename.from), ...pruned])
  const versions = new Map(Object.entries(entry.plugins).map(([pluginName, plugin]) => [pluginName, plugin.version]))
  const known = new Set(Object.keys(entry.plugins))
  let registrable = plugins.filter((candidate) => !applied.excluded.has(candidate.name))
  // a plugin-scoped update registers no newly shipped plugin: auto-install
  // is the full pass's job, not this one's (spec 08)
  if (plugin) registrable = registrable.filter((candidate) => candidate.name in entry.plugins)
  registerPlugins(registry, name, registrable)
  Object.assign(entry.plugins, applied.kept)
  report.renamed = applied.renamed
  report.removed = applied.removed
  report.pruned = pruned
  report.refused = applied.refused
  report.plugins = pluginReports(plugins, entry.plugins, versions, known, pluginFileChanges(entry, report.before, report.after, plugins))
}
