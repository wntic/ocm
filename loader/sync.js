import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { writeJsonAtomic } from "./atomic.js"
import { git, isGitRepo, treePluginFiles } from "./git.js"
import { treeFoldRefusal } from "./limits.js"
import { tryRegistryLock } from "./lock.js"
import { removeMcpKeys } from "./mcp.js"
import { enabledPlugins, materialize } from "./materialize.js"
import { reconcilePluginRecords } from "./reconcile.js"
import { DEFAULT_SYNC_INTERVAL_MS, REGISTRY_FILE, STAMP_FILE } from "./paths.js"
import { isRecord, markTrustPending, ocmSelfVersion, readRegistry, registryWriterVersion, versionCompare } from "./registry.js"
import { executableComponents, trustFingerprint } from "./trust.js"

// spec 08: fetch the pinned ref when there is one, else the remote's HEAD —
// a --branch clone is single-branch, so a bare fetch would follow the
// cloned branch rather than the default. Then hard-reset to FETCH_HEAD,
// with @{u} as the fallback. An unreachable source fails as an ocm error
// naming the url (spec 17).
export async function pullRepo(entry, name) {
  const dir = entry.dir
  const ref = typeof entry.ref === "string" ? entry.ref : null
  const before = (await git(["rev-parse", "HEAD"], dir)).stdout
  // spec 26: `??` lines are untracked, the rest local changes — the counts
  // let the warning name what was discarded
  const status = (await git(["status", "--porcelain"], dir)).stdout.split("\n")
  const untracked = status.filter((line) => line.startsWith("??")).length
  const localChanges = status.filter((line) => line !== "" && !line.startsWith("??")).length
  const dirty = localChanges > 0 || untracked > 0
  const fetch = await git(["fetch", "--depth", "1", "origin", ref || "HEAD"], dir)
  if (!fetch.ok) {
    return {
      ok: false, changed: false, before, after: before, dirty, localChanges, untracked,
      output: `cannot access ${entry.url}${ref ? ` (ref "${ref}")` : ""} — the repository is private, unreachable, or the URL is wrong`,
    }
  }
  // brief 28 §3: the fetched tree is checked before the working tree moves —
  // a folded pair cannot be held on a case-insensitive filesystem, so the
  // reset would leave the clone incomplete (F89)
  const sha = (await git(["rev-parse", "FETCH_HEAD"], dir)).stdout
  const files = await treePluginFiles(dir, "FETCH_HEAD", entry.subdir)
  const fold = files ? treeFoldRefusal(name, sha, files) : null
  if (fold) {
    return { ok: false, changed: false, before, after: before, dirty, localChanges, untracked, output: fold }
  }
  let reset = await git(["reset", "--hard", "FETCH_HEAD"], dir)
  if (!reset.ok) reset = await git(["reset", "--hard", "@{u}"], dir)
  if (!reset.ok) return { ok: false, changed: false, before, after: before, dirty, localChanges, untracked, output: reset.stderr || reset.stdout }
  // spec 26: reset --hard leaves untracked files behind — clean -fd makes
  // "discarded" true and the next run silent
  if (dirty) {
    const clean = await git(["clean", "-fd"], dir)
    if (!clean.ok) return { ok: false, changed: false, before, after: before, dirty, localChanges, untracked, output: clean.stderr || clean.stdout }
  }
  const after = (await git(["rev-parse", "HEAD"], dir)).stdout
  return { ok: true, changed: before !== after, before, after, dirty, localChanges, untracked, output: after }
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
    writeJsonAtomic(REGISTRY_FILE, `${JSON.stringify(raw, null, 2)}\n`)
  } catch {}
}

// spec 20: the sync path refreshes per-plugin component records after every
// pull, exactly as the CLI update does. It runs after materialize — the
// materializer's inputs are computed from the pre-pull records — and writes
// only when reconciliation changed something, so an unchanged pull leaves
// the registry byte-identical. The raw file is mutated in place, never
// migrated, so unknown fields survive.
function refreshRecords(name, root) {
  try {
    const before = readFileSync(REGISTRY_FILE, "utf8")
    const raw = JSON.parse(before)
    if (!isRecord(raw) || raw.version !== 2 || !isRecord(raw.marketplaces?.[name])) return
    const { pruned } = reconcilePluginRecords(raw, name, root)
    if (pruned.length) removeMcpKeys(pruned)
    const after = `${JSON.stringify(raw, null, 2)}\n`
    if (after === before) return
    writeJsonAtomic(REGISTRY_FILE, after)
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

// the loop runs under the registry lock; a skipped sync pulls nothing,
// materializes nothing and writes no lastSync, so every marketplace stays due
async function runSync(entries, options, result) {
  const now = Date.now()
  for (const [name, entry] of entries) {
    // the throttle is per marketplace: one marketplace's sync never
    // suppresses another's (spec 08)
    if (!options.force && !due(entry, now)) continue
    if (!entry || typeof entry.dir !== "string" || !existsSync(entry.dir)) continue
    result.ran = true
    let changed = false
    let revision
    let pulled = false
    // `local === false` rather than `!entry.local`: an entry missing the
    // field must never be treated as an ocm-managed clone
    if (entry.local === false && isGitRepo(entry.dir)) {
      const pull = await pullRepo(entry, name)
      if (!pull.ok) {
        result.failed.push(name)
        result.errors[name] = pull.output
        recordSync(name, { at: new Date().toISOString(), ok: false, error: pull.output })
        continue
      }
      changed = pull.changed
      revision = pull.after
      pulled = true
      if (changed) result.updated.push(name)
      else result.unchanged.push(name)
    } else {
      // a local directory never pulls; its sync is unchanged by definition
      result.unchanged.push(name)
    }
    // discovery roots at the subdir when the source was a tree url (spec 05);
    // git operations above ran against the clone root
    const root = entry.subdir ? join(entry.dir, entry.subdir) : entry.dir
    const links = materialize(name, root, { enabled: enabledPlugins(entry, root) })
    if (links.warnings.length) result.warnings = [...(result.warnings ?? []), ...links.warnings.map((w) => `${name}: ${w}`)]
    if (changed || links.created > 0) result.changed = true
    if (pulled) refreshRecords(name, root)
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

export async function syncAll(options = {}) {
  const result = { ran: false, changed: false, updated: [], unchanged: [], failed: [], errors: {} }
  if (process.env.OCM_SYNC_DISABLE === "1") return result
  // spec 27 §4: an unattended process has nobody to refuse to — a home
  // written by a newer ocm skips the whole sync for this start, exactly as a
  // held lock does: nothing pulled, nothing materialized, no lastSync written
  const writer = registryWriterVersion()
  const self = ocmSelfVersion()
  if (writer && self && versionCompare(writer, self) > 0) return { ...result, skipped: true }
  const registry = readRegistry()
  const entries = Object.entries(registry.marketplaces ?? {})
  if (!entries.length) return result
  const synced = await tryRegistryLock(() => runSync(entries, options, result))
  if (synced.skipped) return { ...result, skipped: true }
  return result
}
