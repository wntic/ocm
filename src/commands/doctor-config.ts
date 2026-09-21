// spec 12 doctor: the opencode.json checks. Every fix goes through the core's
// atomic, ownership-scoped writers (setSkillsPath, removeMcpKeys), which
// return a warning string on failure instead of throwing — a failed write is
// an error finding, never a corrupted config.
import { existsSync, readFileSync } from "node:fs"
import { mcpShapeError, removeMcpKeys, removeMcpKeysExact, setSkillsPath } from "../../loader/core.js"
import type { CoreRegistry } from "../../loader/core.js"
import { OCM_LINKS_DIR, OPENCODE_GLOBAL_CONFIG } from "../paths"
import { error, fixed, warning, type Finding } from "../findings"

// undefined: no config file (normal); null: present but unusable
function readConfig(): Record<string, unknown> | null | undefined {
  let raw: string | undefined
  try {
    raw = readFileSync(OPENCODE_GLOBAL_CONFIG, "utf8")
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {}
  return null
}

export function checkConfig(findings: Finding[], registry: CoreRegistry, fix: boolean, registryUsable: boolean): void {
  const config = readConfig()
  if (config === null) {
    findings.push(warning(`${OPENCODE_GLOBAL_CONFIG}: not valid JSON, left untouched — fix it by hand`))
    return
  }
  if (config === undefined) return
  checkSkillsPaths(config, findings, fix)
  checkMcpKeys(config, registry, findings, fix && registryUsable)
}

// only entries under ocm's links dir are ocm's to remove; a user's orphaned
// entry stays (ownership)
function checkSkillsPaths(config: Record<string, unknown>, findings: Finding[], fix: boolean): void {
  const skills = config.skills
  if (typeof skills !== "object" || skills === null || !Array.isArray((skills as { paths?: unknown }).paths)) return
  for (const entry of (skills as { paths: unknown[] }).paths) {
    if (typeof entry !== "string" || !entry.startsWith(`${OCM_LINKS_DIR}/`) || existsSync(entry)) continue
    if (!fix) {
      findings.push(error(`${entry}: orphaned ocm skills path — target is gone (ocm doctor --fix)`))
      continue
    }
    const failure = setSkillsPath(entry, false)
    if (failure) findings.push(error(failure))
    else findings.push(fixed(`${entry}: removed from skills.paths`))
  }
}

function checkMcpKeys(config: Record<string, unknown>, registry: CoreRegistry, findings: Finding[], fix: boolean): void {
  const mcp = config.mcp
  if (typeof mcp !== "object" || mcp === null || Array.isArray(mcp)) return
  const known = new Set<string>()
  for (const entry of Object.values(registry.marketplaces)) {
    for (const name of Object.keys(entry.plugins ?? {})) known.add(name)
  }
  const orphaned: { key: string; plugin: string }[] = []
  const invalid: { key: string; plugin: string; server: string; shapeError: string }[] = []
  for (const [key, value] of Object.entries(mcp)) {
    if (!key.startsWith("ocm--")) continue
    const rest = key.slice(5)
    const plugin = rest.split("--")[0]!
    if (!known.has(plugin)) orphaned.push({ key, plugin })
    // brief 34 §1.4: every ocm-- entry, not just known plugins' — a bad key
    // written by v0.5.0 predates the registry's shape guarantee
    const shapeError = mcpShapeError(value)
    if (shapeError !== null) invalid.push({ key, plugin, server: rest.slice(plugin.length + 2), shapeError })
  }
  if (!fix) {
    for (const { key, plugin } of orphaned) {
      findings.push(error(`${key}: orphaned MCP key — plugin "${plugin}" is not in the registry`))
    }
    for (const { key, plugin, server, shapeError } of invalid) {
      findings.push(error(`${key}: invalid MCP entry — plugin "${plugin}", server "${server}" ${shapeError}; opencode would refuse to start (ocm doctor --fix)`))
    }
    return
  }
  if (orphaned.length) {
    const removal = removeMcpKeys([...new Set(orphaned.map(({ plugin }) => plugin))])
    if (removal.warning) findings.push(error(removal.warning))
    else for (const { key } of orphaned) findings.push(fixed(`${key}: removed from opencode.json`))
  }
  if (invalid.length) {
    // exactly the offending keys: a valid sibling like ocm--<plugin>--db
    // stays, and so does anything nested under the bad key's name
    const removal = removeMcpKeysExact(invalid.map(({ key }) => key))
    if (removal.warning) findings.push(error(removal.warning))
    else for (const { key } of invalid) findings.push(fixed(`${key}: removed from opencode.json`))
  }
}
