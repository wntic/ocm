import { spawn } from "node:child_process"
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_SYNC_INTERVAL_MS, REGISTRY_FILE, STAMP_FILE } from "./paths.js"
import { enabledPlugins, materialize } from "./materialize.js"
import { isRecord, markTrustPending, readRegistry } from "./registry.js"
import { executableComponents, trustFingerprint } from "./trust.js"

export function isGitRepo(dir) {
  return existsSync(join(dir, ".git"))
}

function git(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish({ ok: false, stdout: "", stderr: "git timed out" })
    }, 120_000)
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.on("error", (err) => finish({ ok: false, stdout: "", stderr: String(err) }))
    child.on("close", (code) => finish({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() }))
  })
}

// spec 08: fetch the pinned ref when there is one, else the remote's HEAD —
// a --branch clone is single-branch, so a bare fetch would follow the
// cloned branch rather than the default. Then hard-reset to FETCH_HEAD,
// with @{u} as the fallback.
export async function pullRepo(dir, ref) {
  const before = (await git(["rev-parse", "HEAD"], dir)).stdout
  const dirty = (await git(["status", "--porcelain"], dir)).stdout !== ""
  const fetch = await git(["fetch", "--depth", "1", "origin", ref || "HEAD"], dir)
  if (!fetch.ok) {
    const detail = fetch.stderr || fetch.stdout
    return {
      ok: false, changed: false, before, after: before, dirty,
      output: ref ? `cannot fetch ref "${ref}": ${detail}` : detail,
    }
  }
  let reset = await git(["reset", "--hard", "FETCH_HEAD"], dir)
  if (!reset.ok) reset = await git(["reset", "--hard", "@{u}"], dir)
  if (!reset.ok) return { ok: false, changed: false, before, after: before, dirty, output: reset.stderr || reset.stdout }
  const after = (await git(["rev-parse", "HEAD"], dir)).stdout
  return { ok: true, changed: before !== after, before, after, dirty, output: after }
}

// the loader never prompts: an unanswered or drifted grant is recorded as
// pending and left for the CLI to surface (spec 07)
function markDriftedTrust(name, entry, root) {
  const trust = entry?.trust
  if (!isRecord(trust) || trust.code === "denied") return
  const components = executableComponents(root, entry)
  if (components.length && (trust.code === "none" || trust.fingerprint !== trustFingerprint(components))) {
    markTrustPending(name)
  }
}

// the loader's only other registry write: lastSync per marketplace, plus the
// revision after a successful pull (spec 02). The raw file is mutated in
// place, never migrated, so unknown fields survive.
function recordSync(name, value, revision) {
  try {
    const raw = JSON.parse(readFileSync(REGISTRY_FILE, "utf8"))
    if (!isRecord(raw) || !isRecord(raw.marketplaces) || !isRecord(raw.marketplaces[name])) return
    raw.marketplaces[name].lastSync = value
    if (typeof revision === "string") raw.marketplaces[name].revision = revision
    const tmp = `${REGISTRY_FILE}.tmp`
    writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`)
    renameSync(tmp, REGISTRY_FILE)
  } catch {}
}

// spec 08: syncIntervalMs beats OCM_SYNC_INTERVAL_MS beats the 1h default;
// 0 means due on every start
function intervalFor(entry) {
  if (typeof entry?.syncIntervalMs === "number") return entry.syncIntervalMs
  const raw = process.env.OCM_SYNC_INTERVAL_MS
  if (raw) {
    const env = Number(raw)
    if (Number.isFinite(env) && env >= 0) return env
  }
  return DEFAULT_SYNC_INTERVAL_MS
}

function due(entry, now) {
  const at = Date.parse(entry?.lastSync?.at ?? "")
  if (Number.isNaN(at)) return true
  return now - at >= intervalFor(entry)
}

export async function syncAll(options = {}) {
  const result = { ran: false, changed: false, updated: [], failed: [] }
  if (process.env.OCM_SYNC_DISABLE === "1") return result
  const registry = readRegistry()
  const entries = Object.entries(registry.marketplaces ?? {})
  if (!entries.length) return result
  const now = Date.now()
  for (const [name, entry] of entries) {
    // the throttle is per marketplace: one marketplace's sync never
    // suppresses another's (spec 08)
    if (!options.force && !due(entry, now)) continue
    if (!entry || typeof entry.dir !== "string" || !existsSync(entry.dir)) continue
    result.ran = true
    let changed = false
    let revision
    // `local === false` rather than `!entry.local`: an entry missing the
    // field must never be treated as an ocm-managed clone
    if (entry.local === false && isGitRepo(entry.dir)) {
      const pull = await pullRepo(entry.dir, typeof entry.ref === "string" ? entry.ref : null)
      if (!pull.ok) {
        result.failed.push(name)
        recordSync(name, { at: new Date().toISOString(), ok: false, error: pull.output })
        continue
      }
      changed = pull.changed
      revision = pull.after
      if (changed) result.updated.push(name)
    }
    // discovery roots at the subdir when the source was a tree url (spec 05);
    // git operations above ran against the clone root
    const root = entry.subdir ? join(entry.dir, entry.subdir) : entry.dir
    const links = materialize(name, root, { enabled: enabledPlugins(entry, root) })
    if (links.warnings.length) result.warnings = [...(result.warnings ?? []), ...links.warnings.map((w) => `${name}: ${w}`)]
    if (changed || links.created > 0) result.changed = true
    markDriftedTrust(name, entry, root)
    recordSync(name, { at: new Date().toISOString(), ok: true, error: null }, revision)
  }
  // the pre-08 global stamp is obsolete: the throttle lives in lastSync.at
  if (result.ran) {
    try {
      rmSync(STAMP_FILE, { force: true })
    } catch {}
  }
  return result
}
