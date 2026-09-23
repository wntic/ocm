import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs"
import { join } from "node:path"
import { rethrowIfDefect } from "./defect.js"
import { errorMessage } from "./error-message.js"
import { OCM_DIR } from "./paths.js"

// beside the registry, never in the cache: the cache is reconstructible and
// may be wiped under the holder's feet
const LOCK_FILE = join(OCM_DIR, "registry.lock")
const POLL_MS = 100
const NOTICE_MS = 1_000
const CEILING_MS = 10_000
const STALE_MS = 10 * 60_000

// "pending" while the holder is between the exclusive create and its write —
// an empty or vanished file is never stale, because breaking it there would
// admit two writers, and that window is wide: a poller lands in it.
//
// An unparseable file is different in kind and stays stale-on-sight. The
// holder writes its record with one writeSync of well under a hundred bytes,
// so a reader observing a torn write is not a window a poller can land in,
// while a partial record left behind by a killed ocm is real — and making
// that wait for the ceiling would cost every later command ten seconds to
// recover from a crash.
function readHolder() {
  let raw
  try {
    raw = readFileSync(LOCK_FILE, "utf8")
  } catch (err) {
    return err?.code === "ENOENT" ? "pending" : null
  }
  if (raw === "") return "pending"
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
    if (!Number.isInteger(parsed.pid) || parsed.pid <= 0) return null
    return {
      pid: parsed.pid,
      at: typeof parsed.at === "string" ? parsed.at : null,
      command: typeof parsed.command === "string" ? parsed.command : "ocm",
    }
  } catch {
    // unparseable record — stale-on-sight, per the design comment above
    return null
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means the process exists but is not ours; only ESRCH is dead
    return err?.code !== "ESRCH"
  }
}

function ageMs(holder) {
  if (!holder?.at) return 0
  const at = Date.parse(holder.at)
  return Number.isNaN(at) ? 0 : Date.now() - at
}

function warnStale(holder) {
  const what = holder ? `pid ${holder.pid}, ${Math.round(ageMs(holder) / 60_000)}m old` : "unreadable"
  process.stderr.write(`warning: removed a stale ocm lock (${what}) — a previous ocm was killed\n`)
}

async function acquire(command, blocking) {
  const started = Date.now()
  let noticed = false
  for (;;) {
    mkdirSync(OCM_DIR, { recursive: true })
    let fd
    try {
      fd = openSync(LOCK_FILE, "wx")
    } catch (err) {
      if (err?.code !== "EEXIST") {
        throw new Error(`cannot write ${LOCK_FILE}: ${errorMessage(err)}`)
      }
      const holder = readHolder()
      const waited = Date.now() - started
      const pending = holder === "pending"
      // a pending lock older than the ceiling is a holder that died mid-create
      const stale = pending
        ? waited >= CEILING_MS
        : !holder || !isAlive(holder.pid) || ageMs(holder) >= STALE_MS
      if (stale) {
        if (blocking) warnStale(pending ? null : holder)
        rmSync(LOCK_FILE, { force: true })
        continue
      }
      if (!blocking) return null
      if (!pending) {
        if (waited >= CEILING_MS) {
          throw new Error(
            `error: another ocm is writing this installation (pid ${holder.pid}, ${holder.command}, started ${Math.round(ageMs(holder) / 1000)}s ago)\n` +
              "  wait for it to finish, or if it is gone, run ocm doctor",
          )
        }
        if (waited >= NOTICE_MS && !noticed) {
          noticed = true
          process.stderr.write(`waiting for another ocm to finish (pid ${holder.pid}, ${holder.command})...\n`)
        }
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
      continue
    }
    writeSync(fd, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString(), command })}\n`)
    closeSync(fd)
    return release
  }
}

// Release only a lock that is still ours. A hold longer than STALE_MS can be
// broken by another ocm while we are still running; the file then belongs to
// whoever broke it, and removing it would admit a second writer behind them —
// the very failure this module exists to prevent.
function release() {
  const holder = readHolder()
  if (holder === "pending" || !holder) return
  if (holder.pid !== process.pid) {
    process.stderr.write(
      `warning: this ocm's lock was broken by another process (now pid ${holder.pid}, ${holder.command})\n` +
        "  its writes and ours may have interleaved — run ocm doctor\n",
    )
    return
  }
  rmSync(LOCK_FILE, { force: true })
}

// the finally is the point: a thrown command, a refused mutation and a clean
// exit all release
export async function withRegistryLock(command, fn) {
  const release = await acquire(command, true)
  try {
    return await fn()
  } finally {
    release()
  }
}

// the loader's single non-blocking attempt: it must never wait and never throw
export async function tryRegistryLock(fn) {
  let release
  try {
    release = await acquire("ocm sync", false)
  } catch (err) {
    rethrowIfDefect(err)
    return { skipped: true }
  }
  if (!release) return { skipped: true }
  try {
    return await fn()
  } finally {
    release()
  }
}
