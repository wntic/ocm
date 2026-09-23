// spec 12 `ocm doctor`: read-mostly diagnosis of an installation. The probe
// runs last, after any fixes, so its report reflects the repaired state.
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { componentRoot, isGitRepo, readRegistry, registryWriterVersion, versionCompare } from "../../loader/core.js"
import type { CoreRegistry } from "../../loader/core.js"
import { installLoader, loaderStatus, packageVersion, reportTuiPlugin, type LoaderFileStatus } from "../loader"
import { materializeLinks } from "../install"
import { OCM_DIR, OCM_LEGACY_REGISTRY_FILE, OCM_LOADER_NAME, OCM_REGISTRY_FILE, OCM_ROOT_CACHE_DIR, OCM_ROOT_SLUG } from "../paths"
import { error, fixed, reportFindings, warning, type Finding } from "../findings"
import { ocmPluginErrors } from "../probe"
import { activeRootHoldsRegistry, relativeXdgWarning, strandedMessage, strandedRoots } from "../stranded"
import { checkConfig } from "./doctor-config"
import { checkBrokenLinks, checkFoldedRecords, checkForbiddenPaths, checkMaterialized, checkStaleRecords } from "./doctor-links"
import { checkDisplaced, checkOrphanMirrors, checkStrays } from "./doctor-orphans"
import { recloneMarketplace } from "./update"

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function doctor(fix: boolean): void {
  // brief 28 §2.2: an install stranded in the other config root replaces the
  // not-installed sentence — the install exists, and `ocm init` would create
  // a second one
  const stranded = strandedRoots()
  const relative = relativeXdgWarning()
  if (!existsSync(OCM_DIR)) {
    if (relative) console.error(`warning: ${relative}`)
    // brief 28 §2.2: every stranded root, not just the first — a user who
    // fixes the first should not discover the second later
    for (const s of stranded) console.error(`error: ${strandedMessage(s)}`)
    if (!stranded.length) console.error("error: ocm is not installed here — run ocm init")
    process.exitCode = 1
    return
  }
  console.log("doctor")
  const findings: Finding[] = []
  if (relative) findings.push(warning(relative))
  // two live installs are a user decision, not a stranding — same condition
  // as reportStrandedNotice
  if (!activeRootHoldsRegistry()) {
    for (const s of stranded) findings.push(error(strandedMessage(s)))
  }
  const registry = readRegistry()
  checkWriterVersion(findings)
  checkGitPath(findings)
  checkLoader(findings, fix)
  // brief 38: name the cache namespace so a user can find their own — only
  // when it exists, or the line names a directory that is not there
  if (existsSync(OCM_ROOT_CACHE_DIR)) {
    console.log(`  cache   ${OCM_ROOT_SLUG} (${OCM_ROOT_CACHE_DIR})`)
  }
  // a registry that cannot be honored must never be read as "nothing owns
  // these files": the stray and MCP fixes stay report-only until it is
  // fixed, or --fix would uninstall everything at once
  const registryUsable = checkRegistryFile(findings)
  checkStrays(registry, findings, fix && registryUsable)
  checkMarketplaces(registry, findings, fix)
  checkLegacyManifests(registry, findings)
  checkCollisions(registry, findings)
  checkBrokenLinks(registry, findings, fix)
  checkConfig(findings, registry, fix, registryUsable)
  checkOrphanMirrors(registry, findings, fix && registryUsable)
  checkDisplaced(registry, findings)
  checkMaterialized(registry, findings, fix)
  checkStaleRecords(registry, findings)
  checkFoldedRecords(registry, findings)
  checkForbiddenPaths(registry, findings)
  for (const line of ocmPluginErrors()) findings.push(error(`${line} (ocm update)`))
  if (reportFindings(findings)) process.exitCode = 1
}

// spec 27 §4: the diagnostic surface of last resort runs especially when the
// versions disagree — warn, and keep checking
function checkWriterVersion(findings: Finding[]): void {
  const writer = registryWriterVersion()
  if (!writer) return
  const self = packageVersion()
  if (versionCompare(writer, self) <= 0) return
  findings.push(
    warning(
      `this installation was last written by ocm ${writer}; you are running ${self}\n` +
        "    upgrade with `npm i -g @wntic/ocm`, or run the newer ocm",
    ),
  )
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
      if (installLoader()) reportTuiPlugin()
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
    findings.push(error(`${OCM_REGISTRY_FILE}: not valid JSON — restore it from a backup, or remove it and re-add your marketplaces`))
    return false
  }
  if (typeof parsed !== "object" || parsed === null || (parsed as Record<string, unknown>).version !== 2) {
    findings.push(error(`${OCM_REGISTRY_FILE}: not a current v2 registry — restore it from a backup, or remove it and re-add your marketplaces`))
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
    findings.push(error(`${OCM_LEGACY_REGISTRY_FILE}: not valid JSON — restore it from a backup, or remove it and re-add your marketplaces`))
    return false
  }
  if (typeof parsed !== "object" || parsed === null) {
    findings.push(error(`${OCM_LEGACY_REGISTRY_FILE}: not a JSON object — restore it from a backup, or remove it and re-add your marketplaces`))
    return false
  }
  return true
}

// spec 20 F27: --fix re-clones a missing git marketplace and re-materializes;
// a local directory is the user's — the remedy is restore-or-remove (F46)
function checkMarketplaces(registry: CoreRegistry, findings: Finding[], fix: boolean): void {
  for (const [name, entry] of Object.entries(registry.marketplaces)) {
    const root = componentRoot(entry)
    if (!existsSync(root)) {
      if (entry.local || !fix) {
        const remedy = entry.local ? `restore the directory, or run ocm remove ${name}` : "ocm update re-clones"
        findings.push(error(`marketplace "${name}": directory missing (${root}) — ${remedy}`))
        continue
      }
      try {
        recloneMarketplace(entry)
        materializeLinks(name, entry)
        findings.push(fixed(`marketplace "${name}": re-cloned and re-materialized (restart opencode to activate)`))
      } catch (err) {
        findings.push(error(`marketplace "${name}": cannot re-clone — ${errText(err)}`))
      }
      continue
    }
    if (!entry.local && !isGitRepo(entry.dir)) {
      findings.push(error(`marketplace "${name}": not a git repository (ocm update)`))
    }
    // spec 25 §2: a trust-pending marketplace is exit-code-relevant — its
    // executable components stay disabled until the user decides
    if (entry.trustPending) {
      findings.push(error(`marketplace "${name}": executable components pulled but not trusted — run ocm trust ${name}`))
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

// spec 19: plugins installed while plugin.json was optional are grandfathered
// — they keep working, and doctor names each once so the boundary move is
// visible. A warning, exit-code-neutral: nothing is broken yet
function checkLegacyManifests(registry: CoreRegistry, findings: Finding[]): void {
  for (const entry of Object.values(registry.marketplaces)) {
    const root = componentRoot(entry)
    if (!existsSync(root)) continue
    for (const [plugin, record] of Object.entries(entry.plugins)) {
      if (existsSync(join(root, record.source, "plugin.json"))) continue
      findings.push(warning(`legacy: "${plugin}" has no plugin.json — add one before its next update`))
    }
  }
}

// spec 18: a recorded collision is a user decision, not a repair — the
// finding names the holder and the takeover command, and --fix changes nothing
function checkCollisions(registry: CoreRegistry, findings: Finding[]): void {
  for (const [name, entry] of Object.entries(registry.marketplaces)) {
    for (const [plugin, record] of Object.entries(entry.plugins)) {
      if (!record.collision || record.enabled) continue
      findings.push(
        error(
          `plugin "${plugin}" from marketplace "${name}" is disabled — the name is owned by marketplace "${record.collision}"\n` +
            `    install with ocm install ${plugin}@${name} --force, or remove one marketplace`,
        ),
      )
    }
  }
}
