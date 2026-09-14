// spec 21: displaced originals are reversible. Every takeover records where
// the user's file went, and every teardown restores what it can — a
// copy-back that never consumes the cache copy, so a later teardown of a
// re-added marketplace restores again from the same place.
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, relative } from "node:path"
import { DISPLACED_RECORD_FILE, OPENCODE_DIR } from "./paths.js"

// paths under the opencode config dir are shown relative to it; anything
// else (skill mirrors live in the cache) stays absolute
export function displayPath(dest) {
  const rel = relative(OPENCODE_DIR, dest)
  return rel.startsWith("..") ? dest : rel
}

export function appendDisplacement(entry) {
  let records = []
  try {
    const parsed = JSON.parse(readFileSync(DISPLACED_RECORD_FILE, "utf8"))
    if (Array.isArray(parsed)) records = parsed
  } catch {}
  records.push(entry)
  mkdirSync(dirname(DISPLACED_RECORD_FILE), { recursive: true })
  writeFileSync(DISPLACED_RECORD_FILE, `${JSON.stringify(records, null, 2)}\n`)
}

function readRecords() {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(DISPLACED_RECORD_FILE, "utf8"))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter((entry) =>
    entry && typeof entry === "object"
      && typeof entry.marketplace === "string"
      && typeof entry.plugin === "string"
      && typeof entry.dest === "string"
      && typeof entry.dir === "string")
}

export function displacedRecords() {
  return readRecords()
}

// the teardown restore pass: one line per displaced original in scope, either
// way — silence is the bug spec 21 fixes. When several displacements hold one
// path the newest wins: it holds the newest version of the user's file.
export function restoreDisplaced(scope) {
  const lines = []
  const latest = new Map()
  for (const record of readRecords()) {
    if (scope.marketplace !== undefined && record.marketplace !== scope.marketplace) continue
    if (scope.plugin !== undefined && record.plugin !== scope.plugin) continue
    latest.set(record.dest, record)
  }
  for (const record of latest.values()) {
    const cache = join(record.dir, record.dest)
    const display = displayPath(record.dest)
    let occupied = false
    try {
      lstatSync(record.dest)
      occupied = true
    } catch {}
    if (occupied) {
      lines.push(`your ${display} was displaced by ${record.plugin} and the path is taken — original kept at ${cache}`)
    } else if (!existsSync(cache)) {
      lines.push(`displacement copy missing: your ${display} was displaced by ${record.plugin} but ${cache} is gone — nothing to restore`)
    } else {
      try {
        mkdirSync(dirname(record.dest), { recursive: true })
        copyFileSync(cache, record.dest)
        lines.push(`restored your ${display} (was displaced by ${record.plugin})`)
      } catch (err) {
        lines.push(`cannot restore your ${display} (was displaced by ${record.plugin}): ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  return lines
}
