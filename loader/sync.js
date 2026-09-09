import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { enabledPlugins, materialize } from "./materialize.js"
import { CACHE_DIR, DEFAULT_SYNC_INTERVAL_MS, STAMP_FILE } from "./paths.js"
import { readRegistry } from "./registry.js"

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

export async function pullRepo(dir) {
  const before = (await git(["rev-parse", "HEAD"], dir)).stdout
  const fetch = await git(["fetch", "--depth", "1", "origin"], dir)
  if (!fetch.ok) return { ok: false, changed: false, output: fetch.stderr || fetch.stdout }
  let reset = await git(["reset", "--hard", "@{u}"], dir)
  if (!reset.ok) reset = await git(["reset", "--hard", "FETCH_HEAD"], dir)
  if (!reset.ok) return { ok: false, changed: false, output: reset.stderr || reset.stdout }
  const after = (await git(["rev-parse", "HEAD"], dir)).stdout
  return { ok: true, changed: before !== after, output: after }
}

export async function syncAll(options = {}) {
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS
  const result = { ran: false, changed: false, updated: [], failed: [] }
  const registry = readRegistry()
  const entries = Object.entries(registry.marketplaces ?? {})
  if (!entries.length) return result
  if (!options.force) {
    let lastSync = 0
    try {
      lastSync = JSON.parse(readFileSync(STAMP_FILE, "utf8")).lastSync ?? 0
    } catch {}
    if (typeof lastSync === "number" && Date.now() - lastSync < minIntervalMs) return result
  }
  result.ran = true
  for (const [name, entry] of entries) {
    if (!entry || typeof entry.dir !== "string" || !existsSync(entry.dir)) continue
    let changed = false
    // `local === false` rather than `!entry.local`: an entry missing the
    // field must never be treated as an ocm-managed clone
    if (entry.local === false && isGitRepo(entry.dir)) {
      const pull = await pullRepo(entry.dir)
      if (!pull.ok) {
        result.failed.push(name)
        continue
      }
      changed = pull.changed
      if (changed) result.updated.push(name)
    }
    // discovery roots at the subdir when the source was a tree url (spec 05);
    // git operations above ran against the clone root
    const root = entry.subdir ? join(entry.dir, entry.subdir) : entry.dir
    const links = materialize(name, root, { enabled: enabledPlugins(entry, root) })
    if (links.warnings.length) result.warnings = [...(result.warnings ?? []), ...links.warnings.map((w) => `${name}: ${w}`)]
    if (changed || links.created > 0) result.changed = true
  }
  try {
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(STAMP_FILE, `${JSON.stringify({ lastSync: Date.now() })}\n`)
  } catch {}
  return result
}
