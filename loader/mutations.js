import { existsSync } from "node:fs"
import { join } from "node:path"
import { writeJsonAtomic } from "./atomic.js"
import { installRefusal, nameHolder } from "./collisions.js"
import { restoreDisplaced } from "./displaced.js"
import { nameDisagreement } from "./manifest.js"
import { componentRoot, deriveComponents, registerPlugins } from "./marketplace.js"
import { enabledPlugins, materialize } from "./materialize.js"
import { DISPLACED_RECORD_FILE } from "./paths.js"
import { reconcilePluginRecords } from "./reconcile.js"
import { loadRegistryForWrite, saveRegistry, saveRegistryIfChanged } from "./registry.js"
import { denyEntry, executableComponents, grantEntry, skipEntry } from "./trust.js"

// spec 05 argument resolution, shared by every verb that takes a plugin
export function resolvePlugin(registry, arg) {
  const at = arg.indexOf("@")
  let marketplace
  let plugin
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
    marketplace = providers[0][0]
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

// spec 18: --force moves a name between marketplaces — the incumbent's
// record yields (disabled, uninstalled) so the name is free to take
function resolveTakeover(registry, resolved, options) {
  const holder = nameHolder(registry, resolved.marketplace, resolved.plugin)
  if (!holder) return null
  if (!options.force) {
    throw new Error(installRefusal(registry, resolved.marketplace, resolved.plugin, holder))
  }
  const incumbent = registry.marketplaces[holder].plugins[resolved.plugin]
  incumbent.enabled = false
  incumbent.installedAt = null
  return holder
}

// spec 05 install/uninstall: flip the record, save, reconcile links. A
// no-op flip saves nothing, so a repeat run writes nothing (idempotence).
// spec 18: installing a name another marketplace holds refuses without
// --force; with it, the incumbent's links come down before the new
// owner's pass, or the old link reads as a self-conflict.
export function setEnabled(arg, enabled, options = {}) {
  const { registry, wasV1 } = loadRegistryForWrite()
  const resolved = resolvePlugin(registry, arg)
  const entry = registry.marketplaces[resolved.marketplace]
  const record = entry.plugins[resolved.plugin]
  const root = componentRoot(entry)
  const current = enabled
    ? record.enabled && record.installedAt
    : !record.enabled && record.installedAt === null
  const holder = enabled && !current ? resolveTakeover(registry, resolved, options) : null
  let saved = false
  if (!current) {
    record.enabled = enabled
    record.installedAt = enabled ? new Date().toISOString() : null
    if (enabled) delete record.collision
    saveRegistry(registry)
    saved = true
  }
  const warnings = []
  let teardownOutcomes = []
  if (holder) {
    // the materializer reads the registry from disk, so the incumbent's
    // yielded state must be saved before its links come down
    const teardown = materialize(holder, componentRoot(registry.marketplaces[holder]), {
      enabled: new Set(),
      plugin: resolved.plugin,
    })
    warnings.push(...teardown.warnings)
    teardownOutcomes = teardown.outcomes
  }
  const report = materialize(resolved.marketplace, root, {
    enabled: enabledPlugins(entry, root),
    force: options.force === true,
  })
  report.warnings.push(...warnings)
  // brief 31 §3/§8: the components a mutation records are its own
  // materialization outcomes — install and uninstall, symmetrically. The
  // returned list is the pre-derive snapshot: the headline states what the
  // record held, the derivation rewrites it after
  const components = record.components
  deriveComponents(registry, resolved.marketplace, report.outcomes)
  if (holder) deriveComponents(registry, holder, teardownOutcomes)
  saveRegistryIfChanged(registry)
  // spec 21: an uninstall surfaces every displaced original it can restore.
  // The holder teardown above is a takeover, which displaces nothing.
  // Spec 27 §3: a consumed record is pruned (`resolved` is the resolvePlugin
  // result here, hence the alias)
  const { lines: restore, resolved: pruned } = enabled
    ? { lines: [], resolved: null }
    : restoreDisplaced({ plugin: resolved.plugin })
  if (pruned) writeJsonAtomic(DISPLACED_RECORD_FILE, `${JSON.stringify(pruned, null, 2)}\n`)
  return {
    marketplace: resolved.marketplace,
    plugin: resolved.plugin,
    components,
    disagreement: nameDisagreement(join(root, record.source), resolved.plugin),
    already: Boolean(current),
    takeover: holder,
    wasV1: wasV1 && saved,
    restore,
    report,
  }
}

export function grantTrust(name) {
  const { registry, wasV1 } = loadRegistryForWrite()
  const entry = registry.marketplaces[name]
  if (!entry) throw new Error(`marketplace "${name}" not found (ocm list)`)
  const root = componentRoot(entry)
  const components = executableComponents(root, entry)
  if (!components.length) return { granted: false, report: null, wasV1: false }
  // spec 20: a grant materializes links, so the records behind those links
  // are refreshed first — otherwise doctor reads the new links as unowned
  const { registrable, kept } = reconcilePluginRecords(registry, name, root)
  registerPlugins(registry, name, registrable)
  // registration replaces the plugins map wholesale, so the records a
  // refused rename kept go back after it
  Object.assign(entry.plugins, kept)
  grantEntry(entry, components)
  saveRegistry(registry)
  const report = materialize(name, root, { enabled: enabledPlugins(entry, root) })
  // brief 31 §3: the records are derived from what materialized, then saved
  // again — a derivation that changed nothing writes nothing
  deriveComponents(registry, name, report.outcomes)
  saveRegistryIfChanged(registry)
  return { granted: true, report, wasV1 }
}

// a `skip` answer persisted: records the shown set so an unchanged
// marketplace never prompts again (spec 16)
export function skipTrust(name) {
  const { registry } = loadRegistryForWrite()
  const entry = registry.marketplaces[name]
  if (!entry) throw new Error(`marketplace "${name}" not found (ocm list)`)
  if (entry.trust.code !== "none") return
  skipEntry(entry, executableComponents(componentRoot(entry), entry))
  saveRegistry(registry)
}

// idempotent: a second deny writes nothing (spec 07)
export function denyTrust(name) {
  const { registry, wasV1 } = loadRegistryForWrite()
  const entry = registry.marketplaces[name]
  if (!entry) throw new Error(`marketplace "${name}" not found (ocm list)`)
  // brief 45 §2: the untrust headline needs the record transition, recorded
  // where it happens — whether this deny revoked a grant
  const wasGranted = entry.trust.code === "granted"
  let saved = false
  if (entry.trust.code !== "denied" || entry.trustPending) {
    denyEntry(entry)
    saveRegistry(registry)
    saved = true
  }
  const root = componentRoot(entry)
  const report = materialize(name, root, { enabled: enabledPlugins(entry, root) })
  return { report, wasV1: wasV1 && saved, wasGranted }
}

export { denyTrust as revokeTrust }
