import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { mcpShapeError, mcpSourceFile, PLUGIN_NAME_RE, readMcpServers } from "./discovery.js"
import { OPENCODE_CONFIG_FILE, OPENCODE_DIR } from "./paths.js"
import { isRecord } from "./registry.js"
import { componentKey } from "./trust.js"

// desired keys are ocm--<plugin>--<server>; every other key in the mcp object
// is the user's and survives byte-identically outside the keys ocm owns.
function applyMcpKeys(desired, prefixes) {
  let raw
  try {
    raw = readFileSync(OPENCODE_CONFIG_FILE, "utf8")
  } catch {}
  let config = {}
  if (raw !== undefined) {
    try {
      config = JSON.parse(raw)
    } catch {
      return `skipped ${OPENCODE_CONFIG_FILE}: not valid JSON, left untouched`
    }
  }
  if (!isRecord(config)) return `skipped ${OPENCODE_CONFIG_FILE}: not a JSON object`
  if (config.mcp !== undefined && !isRecord(config.mcp)) {
    return `skipped ${OPENCODE_CONFIG_FILE}: "mcp" is not an object`
  }
  const mcp = isRecord(config.mcp) ? config.mcp : {}
  let changed = false
  for (const key of Object.keys(mcp)) {
    if (prefixes.some((prefix) => key.startsWith(prefix)) && !desired.has(key)) {
      delete mcp[key]
      changed = true
    }
  }
  for (const [key, value] of desired) {
    if (JSON.stringify(mcp[key]) !== JSON.stringify(value)) {
      mcp[key] = value
      changed = true
    }
  }
  if (!changed) return null
  if (Object.keys(mcp).length) config.mcp = mcp
  else delete config.mcp
  try {
    mkdirSync(OPENCODE_DIR, { recursive: true })
    const tmp = `${OPENCODE_CONFIG_FILE}.tmp`
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`)
    renameSync(tmp, OPENCODE_CONFIG_FILE)
  } catch (err) {
    return `failed ${OPENCODE_CONFIG_FILE}: ${err instanceof Error ? err.message : String(err)}`
  }
  return null
}

// one pass over every discovered plugin: enabled plugins contribute desired
// keys for their approved servers, everything else only the prefix that
// scopes the stale keys removed for it (specs 06, 07)
export function syncMcp(plugins, dir, entry, enabled, approved, warnings, name) {
  const desired = new Map()
  const prefixes = []
  let count = 0
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
      if (!approved.get(componentKey("mcp", plugin.name, server))) {
        warnings.push(`blocked (untrusted): ${plugin.name}:mcp/${server} not installed — run \`ocm trust ${name}\` to approve`)
        continue
      }
      const shapeError = mcpShapeError(value)
      if (shapeError !== null) {
        warnings.push(`${plugin.name}:mcp/${server} not installed — mcp.json entry "${server}" ${shapeError}\n  opencode would refuse to start with it; ask the author to fix it, or run \`ocm validate ${dir}\` against the marketplace`)
        continue
      }
      count += 1
      // brief 34 §1.2: "enabled" is normalised here, at the write, never in
      // readMcpServers — that reader's output is what the trust fingerprint
      // hashes, so normalising there would force a spurious re-trust on upgrade
      const normalised = value.enabled === undefined ? { ...value, enabled: true } : value
      desired.set(`ocm--${plugin.name}--${server}`, normalised)
    }
  }
  const warning = applyMcpKeys(desired, prefixes)
  if (warning) warnings.push(warning)
  return count
}

// spec 05 ocm remove: every ocm--<plugin> and ocm--<plugin>--* mcp key of
// these plugins goes, keeping the mcp object when the user has their own
// servers left in it. Returns a warning instead of printing — the core
// never prints.
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
    return null
  }
  let config
  try {
    config = JSON.parse(raw)
  } catch {
    return `${OPENCODE_CONFIG_FILE} is not valid JSON, left untouched`
  }
  if (!isRecord(config) || !isRecord(config.mcp)) return null
  const mcp = config.mcp
  const owned = Object.keys(mcp).filter((key) => key.startsWith("ocm--") && matches(key))
  if (!owned.length) return null
  for (const key of owned) delete mcp[key]
  if (!Object.keys(mcp).length) delete config.mcp
  try {
    mkdirSync(OPENCODE_DIR, { recursive: true })
    const tmp = `${OPENCODE_CONFIG_FILE}.tmp`
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`)
    renameSync(tmp, OPENCODE_CONFIG_FILE)
  } catch (err) {
    return `cannot write ${OPENCODE_CONFIG_FILE}: ${err instanceof Error ? err.message : String(err)}`
  }
  return null
}
