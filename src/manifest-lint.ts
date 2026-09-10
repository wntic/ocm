// Hand-rolled validator for marketplace.json / plugin.json / mcp.json,
// implementing the same rules as schema/*-v1.json (spec 12: no runtime
// dependency; the schema files exist for editors).
import { existsSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { readRegistry } from "../loader/core.js"
import { error, warning, type Finding } from "./findings"

export const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

const STRING_FIELDS = ["description", "version", "category", "homepage", "repository", "license"]
const ARRAY_FIELDS = ["tags", "keywords"]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// bun's JSON.parse errors carry line/column properties but no position in
// the message itself
function jsonPosition(err: unknown): string {
  const { line, column } = err as { line?: unknown; column?: unknown }
  return typeof line === "number" && typeof column === "number" ? `${line}:${column}` : "0"
}

function parseJson(file: string, rel: string, findings: Finding[]): Record<string, unknown> | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"))
  } catch (err) {
    findings.push(error(`${rel}: invalid JSON at position ${jsonPosition(err)}`))
    return undefined
  }
  if (!isRecord(parsed)) {
    findings.push(error(`${rel}: must be a JSON object`))
    return undefined
  }
  return parsed
}

function lintFields(rel: string, record: Record<string, unknown>, findings: Finding[]): void {
  for (const key of STRING_FIELDS) {
    if (record[key] !== undefined && typeof record[key] !== "string") {
      findings.push(error(`${rel}: "${key}" must be a string`))
    }
  }
  for (const key of ARRAY_FIELDS) {
    const value = record[key]
    if (value !== undefined && (!Array.isArray(value) || !value.every((item) => typeof item === "string"))) {
      findings.push(error(`${rel}: "${key}" must be an array of strings`))
    }
  }
}

function lintName(rel: string, name: string, pluginName: string | undefined, findings: Finding[]): void {
  if (!NAME_RE.test(name)) {
    findings.push(error(`${rel}: name "${name}" must match ${NAME_RE}`))
  } else if (name.length > 64) {
    findings.push(error(`${rel}: name "${name}" is longer than 64 characters`))
  } else if (pluginName !== undefined && name !== pluginName) {
    findings.push(error(`${rel}: name "${name}" disagrees with the directory name "${pluginName}"`))
  }
}

function lintSource(rel: string, entry: Record<string, unknown>, root: string, findings: Finding[]): void {
  const name = typeof entry.name === "string" ? entry.name : "(unnamed)"
  const source = entry.source
  if (typeof source !== "string") {
    findings.push(error(`${rel}: plugins[] entry "${name}" needs a "source"`))
    return
  }
  if (source.split("/").includes("..")) {
    findings.push(error(`${rel}: plugins[] entry "${name}" source "${source}" escapes the marketplace`))
  } else if (!source.startsWith("./")) {
    findings.push(error(`${rel}: plugins[] entry "${name}" source "${source}" must be ./-relative`))
  } else if (!existsSync(join(root, source.slice(2)))) {
    findings.push(error(`${rel}: plugins[] entry "${name}" source "${source}" does not resolve`))
  }
}

// the plugins[]-entry fields beyond the shared string/array ones, per
// schema/marketplace-v1.json
function lintEntryFields(rel: string, entry: Record<string, unknown>, findings: Finding[]): void {
  if (entry.author !== undefined && !isRecord(entry.author)) {
    findings.push(error(`${rel}: "author" must be an object`))
  }
  if (entry.defaultEnabled !== undefined && typeof entry.defaultEnabled !== "boolean") {
    findings.push(error(`${rel}: "defaultEnabled" must be a boolean`))
  }
  if (entry.mcpServers !== undefined && (typeof entry.mcpServers !== "string" || !entry.mcpServers.startsWith("./"))) {
    findings.push(error(`${rel}: "mcpServers" must be a ./-relative path`))
  }
}

function lintPlugins(
  rel: string,
  plugins: unknown,
  root: string,
  manifest: MarketplaceManifest,
  findings: Finding[],
): void {
  if (!Array.isArray(plugins)) {
    findings.push(error(`${rel}: "plugins" must be an array`))
    return
  }
  for (const entry of plugins) {
    if (!isRecord(entry)) {
      findings.push(error(`${rel}: every plugins[] entry must be an object`))
      continue
    }
    lintFields(rel, entry, findings)
    lintEntryFields(rel, entry, findings)
    if (typeof entry.name !== "string") {
      findings.push(error(`${rel}: plugins[] entry needs a "name"`))
    } else {
      lintName(rel, entry.name, undefined, findings)
      manifest.entries.set(entry.name, entry)
    }
    lintSource(rel, entry, root, findings)
  }
}

export interface MarketplaceManifest {
  name?: string
  entries: Map<string, Record<string, unknown>>
}

export function lintMarketplaceJson(root: string, findings: Finding[]): MarketplaceManifest {
  const manifest: MarketplaceManifest = { entries: new Map() }
  const file = join(root, "marketplace.json")
  if (!existsSync(file)) return manifest
  const rel = relative(root, file)
  const parsed = parseJson(file, rel, findings)
  if (!parsed) return manifest
  lintFields(rel, parsed, findings)
  if (parsed.owner !== undefined && !isRecord(parsed.owner)) {
    findings.push(error(`${rel}: "owner" must be an object`))
  }
  if (parsed.renames !== undefined &&
    (!isRecord(parsed.renames) || !Object.values(parsed.renames).every((value) => typeof value === "string" || value === null))) {
    findings.push(error(`${rel}: "renames" must be an object of string or null`))
  }
  if (parsed.name !== undefined && typeof parsed.name !== "string") {
    findings.push(error(`${rel}: "name" must be a string`))
  }
  if (typeof parsed.name === "string") {
    manifest.name = parsed.name
    if (readRegistry().marketplaces[parsed.name]) {
      findings.push(warning(`${rel}: name "${parsed.name}" is already added on this machine`))
    }
  }
  if (parsed.plugins !== undefined) lintPlugins(rel, parsed.plugins, root, manifest, findings)
  return manifest
}

// returns the parsed record so the caller can compare versions across manifests
export function lintPluginJson(
  root: string,
  pluginDir: string,
  pluginName: string,
  findings: Finding[],
): Record<string, unknown> | undefined {
  const file = join(pluginDir, "plugin.json")
  if (!existsSync(file)) return undefined
  const rel = relative(root, file)
  const parsed = parseJson(file, rel, findings)
  if (!parsed) return undefined
  lintFields(rel, parsed, findings)
  if (parsed.author !== undefined && !isRecord(parsed.author)) {
    findings.push(error(`${rel}: "author" must be an object`))
  }
  if (parsed.name !== undefined && typeof parsed.name !== "string") {
    findings.push(error(`${rel}: "name" must be a string`))
  }
  if (typeof parsed.name === "string") lintName(rel, parsed.name, pluginName, findings)
  return parsed
}

export function lintMcpJson(root: string, pluginDir: string, findings: Finding[]): void {
  const file = join(pluginDir, "mcp.json")
  if (!existsSync(file)) return
  const rel = relative(root, file)
  const parsed = parseJson(file, rel, findings)
  if (!parsed) return
  for (const [server, value] of Object.entries(parsed)) {
    if (!isRecord(value) || value.type === undefined) {
      findings.push(error(`${rel}: entry "${server}" is missing "type"`))
    }
  }
}
