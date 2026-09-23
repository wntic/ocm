import { existsSync } from "node:fs"
import { basename, relative } from "node:path"
import { incumbentMarketplace } from "./collisions.js"
import { discoverPlugins } from "./discovery.js"
import { discoverMarketplace } from "./manifest.js"
import { pluginGateFindings } from "./manifest-gate.js"
import { foldedDirPairs, pluginLimitViolation } from "./limits.js"
import { isRecord } from "./registry.js"

// spec 20: one reconciliation of the per-plugin records after a pull or a
// trust grant — the CLI update path and the loader's sync converge here
// rather than keeping two half-copies. Warnings are returned, never printed:
// the core never prints. Brief 31 §3: registration is the caller's job — it
// materializes first, then registers from the outcomes.
export function reconcilePluginRecords(registry, name, root, options = {}) {
  const entry = registry.marketplaces?.[name]
  const warnings = []
  const pruned = []
  const dropped = []
  const renamed = []
  const removed = []
  const refused = []
  const kept = {}
  if (!entry || !existsSync(root)) return { warnings, pruned, dropped, renamed, removed, refused, kept, registrable: [] }
  const plugins = [...(options.discovered ?? discoverMarketplace(root).plugins.values())]
  const shipped = new Set(plugins.map((plugin) => plugin.name))
  const resolved = options.resolved ?? {}
  // brief 40: a recorded refusal is state — it protects the kept record from
  // the prune and its target from registration. A caller that read the
  // manifest's renames clears a record that no longer matches it; one that
  // passed no renames (a trust grant) did not, so the recorded state stands
  const refusals = isRecord(entry.refusedRenames) ? entry.refusedRenames : {}
  if (options.resolved !== undefined) {
    for (const [from, to] of Object.entries(refusals)) {
      if (resolved[from] !== to || !entry.plugins[from]) delete refusals[from]
    }
  }
  // brief 40: renames apply before absence is decided, so the prune below
  // never sees a name that migrated away. A target another marketplace
  // provides is refused: the record stays under its old name and the
  // refusal is recorded on the entry
  for (const [from, to] of Object.entries(resolved)) {
    const record = entry.plugins[from]
    if (!record) continue
    if (to === null) {
      delete entry.plugins[from]
      removed.push(from)
      continue
    }
    const incumbent = incumbentMarketplace(registry, name, to)
    if (incumbent) {
      refusals[from] = to
      const dir = plugins.find((plugin) => plugin.name === to)?.dir ?? null
      // the record's source follows the disk so doctor's legacy check sees
      // a real directory
      if (dir !== null) record.source = relative(root, dir)
      refused.push({ from, to, incumbent, dir })
      continue
    }
    // the target is not shipped (yet): the record dangles rather than moves
    if (!shipped.has(to)) continue
    entry.plugins[to] = record
    delete entry.plugins[from]
    delete refusals[from]
    renamed.push({ from, to })
  }
  // derived from the final refusal state, so a refusal that cleared this
  // run — the incumbent went away — registers its target again
  const excluded = new Set(Object.values(refusals))
  // registration replaces the plugins map wholesale, so the caller re-adds
  // these after it
  for (const from of Object.keys(refusals)) {
    if (entry.plugins[from]) kept[from] = entry.plugins[from]
  }
  for (const pluginName of Object.keys(entry.plugins)) {
    if (!shipped.has(pluginName) && !(pluginName in resolved) && !(pluginName in refusals)) {
      delete entry.plugins[pluginName]
      pruned.push(pluginName)
    }
  }
  if (Object.keys(refusals).length) entry.refusedRenames = refusals
  else delete entry.refusedRenames
  let registrable = plugins.filter((candidate) => !excluded.has(candidate.name))
  // spec 17: an upstream name that breaks a length limit skips that plugin;
  // the rest of the update proceeds. The warning is the materializer's — it
  // emits one skipped outcome per component (brief 31 §4), and every caller
  // materializes
  registrable = registrable.filter((candidate) => !pluginLimitViolation(candidate))
  // brief 28 §3: a folded pair lowercases to one plugin name; the pair is
  // skipped with the warning and the rest of the update proceeds. The raw
  // discovery list is re-read because the passed-in one is the manifest
  // map, which has already collapsed the pair.
  const folded = new Map(
    foldedDirPairs(discoverPlugins(root).map((plugin) => basename(plugin.dir))).map((pair) => [pair[0].toLowerCase(), pair]),
  )
  registrable = registrable.filter((candidate) => {
    const pair = folded.get(candidate.name)
    if (!pair) return true
    warnings.push(`plugins/${pair[0]} and plugins/${pair[1]} differ only in case — plugin "${candidate.name}" skipped; ask the author to rename one and update again`)
    // brief 45 §4 (F221): record the drop so the update reports an
    // uninstalled item instead of "already up to date". Installed-only,
    // mirroring the manifest gate below — a never-installed candidate was
    // never on disk, so an "uninstalled" line for it would be a lie.
    if (entry.plugins[candidate.name]?.installedAt != null) {
      dropped.push({ name: candidate.name, reason: `plugins/${pair[0]} and plugins/${pair[1]} differ only in case` })
    }
    return false
  })
  // spec 19 / brief 29 §3: a plugin failing the manifest gate is refused —
  // new upstream ones are not installed, and an installed one is
  // grandfathered only until it changes
  registrable = registrable.filter((candidate) => {
    const findings = pluginGateFindings(root, candidate)
    if (!findings.length) return true
    if (candidate.name in entry.plugins && !(options.changed ?? new Set()).has(candidate.name)) return true
    const finding = findings[0]
    if (entry.plugins[candidate.name]?.installedAt == null) {
      warnings.push(
        finding.code === "manifest-missing"
          ? `plugin "${candidate.name}": plugins/${candidate.name}/plugin.json is missing — not installed; ` +
              'add one ({ "description": "…" }) and update again'
          : `plugin "${candidate.name}": ${finding.message} — not installed; fix it and update again`,
      )
      return false
    }
    delete entry.plugins[candidate.name]
    if (finding.code === "manifest-missing") {
      warnings.push(
        `plugin "${candidate.name}": changed upstream and still has no plugin.json — uninstalled\n` +
          "  it predates the plugin.json requirement and kept working until it changed\n" +
          `  add plugins/${candidate.name}/plugin.json ({ "description": "…" }) and run ocm update to reinstall it`,
      )
      dropped.push({ name: candidate.name, reason: "plugin.json required now that it changed" })
    } else {
      warnings.push(
        `plugin "${candidate.name}": changed upstream and no longer passes the manifest gate — uninstalled\n` +
          `  ${finding.message}\n` +
          "  fix it and run ocm update to reinstall it",
      )
      dropped.push({ name: candidate.name, reason: finding.message })
    }
    return false
  })
  return { warnings, pruned, dropped, renamed, removed, refused, kept, registrable }
}
