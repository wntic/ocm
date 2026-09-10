import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { discoverPlugins, mcpSourceFile } from "./discovery.js"
import { isRecord } from "./registry.js"

// canonical JSON: keys sorted at every level, so reordering mcp.json leaves a
// server entry's hash alone while a command change does not (spec 07)
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (isRecord(value)) {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex")
}

// `plugin` and `plugins` are both valid source directories (spec 06)
function pluginFile(pluginDir, file) {
  for (const dir of ["plugin", "plugins"]) {
    const path = join(pluginDir, dir, file)
    try {
      return { path, content: readFileSync(path) }
    } catch {}
  }
  return null
}

// every executable component of every discovered plugin, sorted by its
// marketplace-relative path: plugins/<p>/plugin/*.{js,ts} files and every
// server entry in a plugin's mcp.json (spec 07)
export function executableComponents(dir, entry) {
  const components = []
  for (const plugin of discoverPlugins(dir)) {
    for (const file of plugin.components.plugin ?? []) {
      const source = pluginFile(plugin.dir, file)
      if (!source) continue
      components.push({
        rel: relative(dir, source.path),
        hash: sha256(source.content),
        kind: "plugin",
        plugin: plugin.name,
        name: file,
      })
    }
    const mcpFile = mcpSourceFile(dir, entry, plugin)
    let servers = null
    try {
      const parsed = JSON.parse(readFileSync(mcpFile, "utf8"))
      if (isRecord(parsed)) servers = parsed
    } catch {}
    for (const [server, value] of Object.entries(servers ?? {})) {
      components.push({
        rel: `${relative(dir, mcpFile)}:${server}`,
        hash: sha256(canonicalJson(value)),
        kind: "mcp",
        plugin: plugin.name,
        name: server,
        value,
      })
    }
  }
  return components.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}

// sha256 over "<relative path>\n<sha256 of contents>\n" per component, in
// path order — the fingerprint recorded at grant time (spec 07)
export function trustFingerprint(components) {
  const hash = createHash("sha256")
  for (const component of components) {
    hash.update(`${component.rel}\n${component.hash}\n`)
  }
  return hash.digest("hex")
}

export function componentKey(kind, plugin, name) {
  return `${kind}\n${plugin}\n${name}`
}

// the in-memory halves of a trust decision: applied to a loaded entry and
// saved by the caller (spec 07)
export function grantEntry(entry, components) {
  entry.trust = {
    code: "granted",
    grantedAt: new Date().toISOString(),
    fingerprint: trustFingerprint(components),
    components: Object.fromEntries(components.map((c) => [c.rel, c.hash])),
  }
  delete entry.trustPending
}

export function denyEntry(entry) {
  entry.trust = { code: "denied" }
  delete entry.trustPending
}

// the materializer's per-component gate: approved iff the marketplace is
// granted and the component's hash matches the grant record. A grant without
// a record (written by hand before spec 07) approves everything.
export function approvedComponents(dir, entry) {
  const trust = entry?.trust
  const granted = trust?.code === "granted"
  const recorded = granted && isRecord(trust.components) ? trust.components : null
  const approved = new Map()
  for (const component of executableComponents(dir, entry)) {
    const ok = granted && (recorded === null || recorded[component.rel] === component.hash)
    approved.set(componentKey(component.kind, component.plugin, component.name), ok)
  }
  return approved
}
