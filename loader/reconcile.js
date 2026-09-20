import { existsSync } from "node:fs"
import { basename } from "node:path"
import { discoverPlugins } from "./discovery.js"
import { discoverMarketplace } from "./manifest.js"
import { pluginGateFindings } from "./manifest-gate.js"
import { foldedDirPairs, pluginLimitViolation } from "./limits.js"
import { registerPlugins } from "./marketplace.js"

// spec 20: one reconciliation of the per-plugin records after a pull or a
// trust grant — the CLI update path and the loader's sync converge here
// rather than keeping two half-copies. Warnings are returned, never printed:
// the core never prints.
export function reconcilePluginRecords(registry, name, root, options = {}) {
  const entry = registry.marketplaces?.[name]
  const warnings = []
  const pruned = []
  const dropped = []
  if (!entry || !existsSync(root)) return { warnings, pruned, dropped }
  const plugins = [...(options.discovered ?? discoverMarketplace(root).plugins.values())]
  const shipped = new Set(plugins.map((plugin) => plugin.name))
  const resolved = options.resolved ?? {}
  for (const pluginName of Object.keys(entry.plugins)) {
    if (!shipped.has(pluginName) && !(pluginName in resolved)) {
      delete entry.plugins[pluginName]
      pruned.push(pluginName)
    }
  }
  let registrable = plugins.filter((candidate) => !(options.excluded ?? new Set()).has(candidate.name))
  // a plugin-scoped update registers no newly shipped plugin: auto-install
  // is the full pass's job, not this one's (spec 08)
  if (options.plugin) registrable = registrable.filter((candidate) => candidate.name in entry.plugins)
  // spec 17: an upstream name that breaks a length limit skips that plugin
  // with the limit named; the rest of the update proceeds
  registrable = registrable.filter((candidate) => {
    const violation = pluginLimitViolation(candidate)
    if (violation) warnings.push(`${violation}; rename it in the marketplace and update again`)
    return !violation
  })
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
  registerPlugins(registry, name, registrable)
  return { warnings, pruned, dropped }
}
