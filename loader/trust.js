import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { discoverPlugins, mcpSourceFile, readMcpServers } from "./discovery.js"
import { refusalAliases } from "./renames.js"
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
// server entry in a plugin's mcp.json (spec 07). Brief 40: a refused
// rename's target reports under the kept name and path, so the fingerprint
// matches the grant recorded before the plugin moved while a content
// change still drifts
export function executableComponents(dir, entry) {
  const aliases = refusalAliases(entry)
  const components = []
  for (const discovered of discoverPlugins(dir)) {
    const kept = aliases.get(discovered.name)
    const plugin = kept === undefined ? discovered : { ...discovered, name: kept }
    const rewrite = (rel) => (kept === undefined ? rel : rel.replace(`plugins/${discovered.name}/`, `plugins/${kept}/`))
    for (const file of plugin.components.plugin ?? []) {
      const source = pluginFile(plugin.dir, file)
      if (!source) continue
      components.push({
        rel: rewrite(relative(dir, source.path)),
        hash: sha256(source.content),
        kind: "plugin",
        plugin: plugin.name,
        name: file,
      })
    }
    const mcpFile = mcpSourceFile(dir, entry, plugin)
    // both mcp.json shapes, so the fingerprint covers the servers that will
    // actually run rather than an Agent Plugins wrapper key
    const servers = readMcpServers(mcpFile)
    for (const [server, value] of Object.entries(servers ?? {})) {
      // metadata, not a server: it must never be offered for approval, nor
      // sit in the fingerprint (brief 34 §1.1 — the readers agree)
      if (server === "$schema") continue
      components.push({
        rel: rewrite(`${relative(dir, mcpFile)}:${server}`),
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

// the components a trust prompt is about: new ones, or ones whose hash
// changed since the grant. A grant without per-component records (written by
// hand before spec 07) approves everything, so nothing is pending (spec 16)
export function pendingComponents(entry, components) {
  const trust = entry?.trust
  if (!trust || trust.code === "denied") return []
  const recorded = isRecord(trust.components) ? trust.components : null
  if (recorded === null) return trust.code === "none" ? components : []
  return components.filter((c) => recorded[c.rel] !== c.hash && recorded[c.rel] !== `!${c.hash}`)
}

// a `skip` answer: record the shown set under the undecided code, so the
// prompt returns only when something new arrives. Never called under a
// grant — recording there would silently approve drift (spec 16)
export function skipEntry(entry, components) {
  const recorded = isRecord(entry.trust.components) ? entry.trust.components : {}
  for (const component of components) recorded[component.rel] = component.hash
  entry.trust.components = recorded
}

// a declined re-prompt: deny only the components it was about, recorded as
// "!" + hash so the materializer's exact-match check blocks them; the rest
// of the grant keeps running (spec 16)
export function denyComponentsEntry(entry, pending) {
  const recorded = isRecord(entry.trust.components) ? entry.trust.components : {}
  for (const component of pending) recorded[component.rel] = `!${component.hash}`
  entry.trust.components = recorded
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
