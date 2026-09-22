import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { mcpShapeError, mcpSourceFile, PLUGIN_NAME_RE, readMcpServers } from "./discovery.js"
import { OPENCODE_CONFIG_FILE, OPENCODE_DIR } from "./paths.js"
import { isRecord } from "./registry.js"
import { componentKey } from "./trust.js"

// desired keys are ocm--<plugin>--<server>; every other key in the mcp object
// is the user's and survives byte-identically outside the keys ocm owns.
// Returns one outcome per key it touched — created, or removed when a stale
// key went — and a warning instead when nothing could be written.
function applyMcpKeys(desired, prefixes) {
  let raw
  try {
    raw = readFileSync(OPENCODE_CONFIG_FILE, "utf8")
  } catch {
    // a missing config reads as empty
  }
  let config = {}
  if (raw !== undefined) {
    try {
      config = JSON.parse(raw)
    } catch {
      return { warning: `skipped ${OPENCODE_CONFIG_FILE}: not valid JSON, left untouched`, outcomes: [] }
    }
  }
  if (!isRecord(config)) return { warning: `skipped ${OPENCODE_CONFIG_FILE}: not a JSON object`, outcomes: [] }
  if (config.mcp !== undefined && !isRecord(config.mcp)) {
    return { warning: `skipped ${OPENCODE_CONFIG_FILE}: "mcp" is not an object`, outcomes: [] }
  }
  const mcp = isRecord(config.mcp) ? config.mcp : {}
  let changed = false
  const outcomes = []
  for (const key of Object.keys(mcp)) {
    if (prefixes.some((prefix) => key.startsWith(prefix)) && !desired.has(key)) {
      delete mcp[key]
      changed = true
      outcomes.push(mcpKeyOutcome(key, "removed"))
    }
  }
  for (const [key, value] of desired) {
    if (JSON.stringify(mcp[key]) !== JSON.stringify(value)) {
      mcp[key] = value
      changed = true
      outcomes.push(mcpKeyOutcome(key, "created"))
    }
  }
  if (!changed) return { warning: null, outcomes }
  if (Object.keys(mcp).length) config.mcp = mcp
  else delete config.mcp
  try {
    mkdirSync(OPENCODE_DIR, { recursive: true })
    const tmp = `${OPENCODE_CONFIG_FILE}.tmp`
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`)
    renameSync(tmp, OPENCODE_CONFIG_FILE)
  } catch (err) {
    return { warning: `failed ${OPENCODE_CONFIG_FILE}: ${err instanceof Error ? err.message : String(err)}`, outcomes: [] }
  }
  return { warning: null, outcomes }
}

// plugin names cannot contain "--" (PLUGIN_NAME_RE), so the first "--" after
// the ocm-- prefix ends the plugin segment
function mcpKeyOutcome(key, state) {
  return { type: "mcp", plugin: key.slice(5).split("--")[0], component: key, source: null, dest: key, state, reason: null }
}

// one pass over every discovered plugin: enabled plugins contribute desired
// keys for their approved servers, everything else only the prefix that
// scopes the stale keys removed for it (specs 06, 07). Returns one outcome
// per server; a config that could not be written yields none — the warning
// explains, nothing was materialized.
export function syncMcp(plugins, dir, entry, enabled, approved, warnings, name) {
  const desired = new Map()
  const prefixes = []
  const outcomes = []
  for (const plugin of plugins) {
    if (!PLUGIN_NAME_RE.test(plugin.name)) continue
    prefixes.push(`ocm--${plugin.name}--`)
    if (enabled !== null && !enabled.has(plugin.name)) continue
    const file = mcpSourceFile(dir, entry, plugin)
    if (!(plugin.components.mcp ?? []).length && !existsSync(file)) continue
    const servers = readMcpServers(file)
    if (servers === null) {
      warnings.push(`skipped ${file}: not a JSON object`)
      continue
    }
    for (const [server, value] of Object.entries(servers)) {
      // $schema is metadata, not a server entry — lintMcpJson skips it too;
      // readMcpServers returns native files verbatim, $schema included
      if (server === "$schema") continue
      const dest = `ocm--${plugin.name}--${server}`
      if (!approved.get(componentKey("mcp", plugin.name, server))) {
        const reason = `blocked (untrusted): ${plugin.name}:mcp/${server} not installed — run \`ocm trust ${name}\` to approve`
        warnings.push(reason)
        outcomes.push({ type: "mcp", plugin: plugin.name, component: server, source: null, dest, state: "blocked", reason })
        continue
      }
      const shapeError = mcpShapeError(value)
      if (shapeError !== null) {
        const reason = `${plugin.name}:mcp/${server} not installed — mcp.json entry "${server}" ${shapeError}\n  opencode would refuse to start with it; ask the author to fix it, or run \`ocm validate ${dir}\` against the marketplace`
        warnings.push(reason)
        outcomes.push({ type: "mcp", plugin: plugin.name, component: server, source: null, dest, state: "skipped", reason })
        continue
      }
      // brief 34 §1.2: "enabled" is normalised here, at the write, never in
      // readMcpServers — that reader's output is what the trust fingerprint
      // hashes, so normalising there would force a spurious re-trust on upgrade
      const normalised = value.enabled === undefined ? { ...value, enabled: true } : value
      desired.set(dest, normalised)
      outcomes.push({ type: "mcp", plugin: plugin.name, component: server, source: null, dest, state: "current", reason: null })
    }
  }
  const { warning, outcomes: applied } = applyMcpKeys(desired, prefixes)
  if (warning) {
    warnings.push(warning)
    return []
  }
  for (const outcome of applied) {
    if (outcome.state === "removed") outcomes.push(outcome)
    else if (outcome.state === "created") {
      const current = outcomes.find((o) => o.state === "current" && o.dest === outcome.dest)
      if (current) current.state = "created"
    }
  }
  return outcomes
}

// spec 05 ocm remove: every ocm--<plugin> and ocm--<plugin>--* mcp key of
// these plugins goes, keeping the mcp object when the user has their own
// servers left in it. Returns one removed outcome per key it took and a
// warning instead of printing — the core never prints.
export function removeMcpKeys(pluginNames) {
  return removeOwnedMcp((key) =>
    pluginNames.some((name) => key === `ocm--${name}` || key.startsWith(`ocm--${name}--`)),
  )
}

// doctor's invalid-entry fix needs key precision, not plugin-scoped removal:
// exactly these keys go, and a valid sibling under the same plugin stays.
// Passing a key's suffix to removeMcpKeys would work through its prefix
// branch and also take ocm--<plugin>--<key>--*, which is not what was asked.
export function removeMcpKeysExact(keys) {
  const wanted = new Set(keys)
  return removeOwnedMcp((key) => wanted.has(key))
}

function removeOwnedMcp(matches) {
  let raw
  try {
    raw = readFileSync(OPENCODE_CONFIG_FILE, "utf8")
  } catch {
    // a missing config has no keys to remove
    return { outcomes: [], warning: null }
  }
  let config
  try {
    config = JSON.parse(raw)
  } catch {
    return { outcomes: [], warning: `${OPENCODE_CONFIG_FILE} is not valid JSON, left untouched` }
  }
  if (!isRecord(config) || !isRecord(config.mcp)) return { outcomes: [], warning: null }
  const mcp = config.mcp
  const owned = Object.keys(mcp).filter((key) => key.startsWith("ocm--") && matches(key))
  if (!owned.length) return { outcomes: [], warning: null }
  for (const key of owned) delete mcp[key]
  if (!Object.keys(mcp).length) delete config.mcp
  try {
    mkdirSync(OPENCODE_DIR, { recursive: true })
    const tmp = `${OPENCODE_CONFIG_FILE}.tmp`
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`)
    renameSync(tmp, OPENCODE_CONFIG_FILE)
  } catch (err) {
    return { outcomes: [], warning: `cannot write ${OPENCODE_CONFIG_FILE}: ${err instanceof Error ? err.message : String(err)}` }
  }
  return { outcomes: owned.map((key) => mcpKeyOutcome(key, "removed")), warning: null }
}
