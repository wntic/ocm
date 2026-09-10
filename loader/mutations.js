import { existsSync } from "node:fs"
import { join } from "node:path"
import { nameDisagreement } from "./manifest.js"
import { componentRoot } from "./marketplace.js"
import { enabledPlugins, materialize } from "./materialize.js"
import { loadRegistryForWrite, saveRegistry } from "./registry.js"
import { denyEntry, executableComponents, grantEntry } from "./trust.js"

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

// spec 05 install/uninstall: flip the record, save, reconcile links. A
// no-op flip saves nothing, so a repeat run writes nothing (idempotence).
export function setEnabled(arg, enabled, options = {}) {
  const { registry, wasV1 } = loadRegistryForWrite()
  const resolved = resolvePlugin(registry, arg)
  const entry = registry.marketplaces[resolved.marketplace]
  const record = entry.plugins[resolved.plugin]
  const root = componentRoot(entry)
  const current = enabled
    ? record.enabled && record.installedAt
    : !record.enabled && record.installedAt === null
  let saved = false
  if (!current) {
    record.enabled = enabled
    record.installedAt = enabled ? new Date().toISOString() : null
    saveRegistry(registry)
    saved = true
  }
  const report = materialize(resolved.marketplace, root, {
    enabled: enabledPlugins(entry, root),
    force: options.force === true,
  })
  return {
    marketplace: resolved.marketplace,
    plugin: resolved.plugin,
    components: record.components,
    disagreement: nameDisagreement(join(root, record.source), resolved.plugin),
    wasV1: wasV1 && saved,
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
  grantEntry(entry, components)
  saveRegistry(registry)
  const report = materialize(name, root, { enabled: enabledPlugins(entry, root) })
  return { granted: true, report, wasV1 }
}

// idempotent: a second deny writes nothing (spec 07)
export function denyTrust(name) {
  const { registry, wasV1 } = loadRegistryForWrite()
  const entry = registry.marketplaces[name]
  if (!entry) throw new Error(`marketplace "${name}" not found (ocm list)`)
  let saved = false
  if (entry.trust.code !== "denied" || entry.trustPending) {
    denyEntry(entry)
    saveRegistry(registry)
    saved = true
  }
  const root = componentRoot(entry)
  const report = materialize(name, root, { enabled: enabledPlugins(entry, root) })
  return { report, wasV1: wasV1 && saved }
}

export { denyTrust as revokeTrust }
