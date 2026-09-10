// spec 12 `ocm doctor`: read-mostly diagnosis of an installation. The probe
// runs last, after any fixes, so its report reflects the repaired state.
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { componentRoot, isGitRepo, readRegistry } from "../../loader/core.js"
import type { CoreRegistry } from "../../loader/core.js"
import { installLoader, loaderStatus, type LoaderFileStatus } from "../loader"
import { OCM_LEGACY_REGISTRY_FILE, OCM_LOADER_NAME, OCM_REGISTRY_FILE } from "../paths"
import { error, fixed, reportFindings, warning, type Finding } from "../findings"
import { ocmPluginErrors } from "../probe"
import { checkConfig } from "./doctor-config"
import { checkBrokenLinks, checkForbiddenPaths, checkMaterialized, checkStrays } from "./doctor-links"

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function doctor(fix: boolean): void {
  console.log("doctor")
  const findings: Finding[] = []
  const registry = readRegistry()
  checkGitPath(findings)
  checkLoader(findings, fix)
  // a registry that cannot be honored must never be read as "nothing owns
  // these files": the stray and MCP fixes stay report-only until it is
  // fixed, or --fix would uninstall everything at once
  const registryUsable = checkRegistryFile(findings)
  checkStrays(registry, findings, fix && registryUsable)
  checkMarketplaces(registry, findings)
  checkBrokenLinks(registry, findings, fix)
  checkConfig(findings, registry, fix, registryUsable)
  checkMaterialized(registry, findings, fix)
  checkForbiddenPaths(registry, findings)
  for (const line of ocmPluginErrors()) findings.push(error(`${line} (ocm update)`))
  if (reportFindings(findings)) process.exitCode = 1
}

function checkGitPath(findings: Finding[]): void {
  const run = spawnSync("git", ["--version"], { encoding: "utf8", timeout: 10_000 })
  if (run.error || run.status !== 0) {
    findings.push(warning("git is not on PATH — ocm update and the loader's sync need it"))
  }
}

// the report names the loader trio; the remaining installed files surface
// only when broken
function checkLoader(findings: Finding[], fix: boolean): void {
  let files: LoaderFileStatus[]
  try {
    files = loaderStatus()
  } catch (err) {
    findings.push(error(`cannot check the loader — ${errText(err)}`))
    return
  }
  for (const file of files) {
    if ([OCM_LOADER_NAME, "core.js", "ui.js"].includes(file.file)) {
      console.log(`  loader  ${file.file} (${file.state})`)
    }
  }
  const broken = files.filter((file) => file.state !== "current")
  if (!broken.length) return
  if (fix) {
    try {
      installLoader()
      findings.push(fixed(`reinstalled ${broken.length} loader file(s) (restart opencode to activate)`))
    } catch (err) {
      findings.push(error(`cannot reinstall the loader — ${errText(err)}`))
    }
    return
  }
  for (const file of broken) {
    findings.push(error(file.state === "missing"
      ? `${file.file}: not installed (ocm init)`
      : `${file.file}: stale version comment — a stale core silently no-ops (ocm update)`))
  }
}

// returns whether the on-disk registry can be honored; a missing file is a
// genuinely empty registry, but an unusable one must gate the fixes that
// trust its ownership records
function checkRegistryFile(findings: Finding[]): boolean {
  let raw: string
  try {
    raw = readFileSync(OCM_REGISTRY_FILE, "utf8")
  } catch {
    return checkLegacyRegistryFile(findings)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    findings.push(error(`${OCM_REGISTRY_FILE}: not valid JSON (ocm update)`))
    return false
  }
  if (typeof parsed !== "object" || parsed === null || (parsed as Record<string, unknown>).version !== 2) {
    findings.push(error(`${OCM_REGISTRY_FILE}: not a current v2 registry (ocm update)`))
    return false
  }
  return true
}

// readRegistry falls back to the pre-02 plugins/ocm-registry.json when the
// v2 file is absent and silently swallows a parse failure — the same
// lost-ownership failure mode, so it gates the registry-trusting fixes too
function checkLegacyRegistryFile(findings: Finding[]): boolean {
  let raw: string
  try {
    raw = readFileSync(OCM_LEGACY_REGISTRY_FILE, "utf8")
  } catch {
    return true
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    findings.push(error(`${OCM_LEGACY_REGISTRY_FILE}: not valid JSON (ocm update)`))
    return false
  }
  if (typeof parsed !== "object" || parsed === null) {
    findings.push(error(`${OCM_LEGACY_REGISTRY_FILE}: not a JSON object (ocm update)`))
    return false
  }
  return true
}

function checkMarketplaces(registry: CoreRegistry, findings: Finding[]): void {
  for (const [name, entry] of Object.entries(registry.marketplaces)) {
    const root = componentRoot(entry)
    if (!existsSync(root)) {
      findings.push(error(`marketplace "${name}": directory missing (${root}) — ocm update re-clones`))
      continue
    }
    if (!entry.local && !isGitRepo(entry.dir)) {
      findings.push(error(`marketplace "${name}": not a git repository (ocm update)`))
    }
    const lastSync = entry.lastSync
    if (lastSync?.ok === false) {
      const age = Date.now() - Date.parse(lastSync.at)
      const minutes = Number.isFinite(age) ? Math.max(0, Math.round(age / 60_000)) : 0
      const first = lastSync.error?.split("\n").map((line) => line.trim()).find(Boolean) ?? "unknown error"
      findings.push(error(`marketplace "${name}": last sync failed ${minutes}m ago: ${first}`))
    }
  }
}
