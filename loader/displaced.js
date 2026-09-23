// spec 21: displaced originals are reversible. Every takeover records where
// the user's file went, and every teardown restores what it can. Spec 27 §3
// amends this: the cache copy is still never consumed (a mistake stays
// recoverable), but a resolved record is pruned so it stops being re-reported.
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
} from "node:fs"
import { dirname, join, relative } from "node:path"
import { writeJsonAtomic } from "./atomic.js"
import { errorMessage } from "./error-message.js"
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
  } catch {
    // a missing or unparseable records file starts a fresh list
  }
  records.push(entry)
  writeJsonAtomic(DISPLACED_RECORD_FILE, `${JSON.stringify(records, null, 2)}\n`)
}

function readRecords() {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(DISPLACED_RECORD_FILE, "utf8"))
  } catch {
    // a missing or unparseable records file reads as no records
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
// Spec 27 §3: a resolved record (restored, copy gone, or dest already holding
// the original bytes) is consumed — dropped from the records file while its
// cache copy is kept.
export function restoreDisplaced(scope) {
  const lines = []
  const records = readRecords()
  const latest = new Map()
  for (const record of records) {
    if (scope.marketplace !== undefined && record.marketplace !== scope.marketplace) continue
    if (scope.plugin !== undefined && record.plugin !== scope.plugin) continue
    latest.set(record.dest, record)
  }
  const consumed = new Set()
  for (const record of latest.values()) {
    const cache = join(record.dir, record.dest)
    const display = displayPath(record.dest)
    let occupied = false
    try {
      lstatSync(record.dest)
      occupied = true
    } catch {
      // an absent path is not occupied — the restore may proceed
    }
    if (occupied) {
      // a full byte compare, no size or mtime shortcut: only content that is
      // already the original counts as restored
      let identical = false
      try {
        identical = readFileSync(record.dest).equals(readFileSync(cache))
      } catch {
        // an unreadable side means not identical — the path is reported taken
      }
      if (identical) {
        consumed.add(record)
      } else {
        lines.push(`your ${display} was displaced by ${record.plugin} and the path is taken — original kept at ${cache}`)
      }
    } else if (!existsSync(cache)) {
      lines.push(`displacement copy missing: your ${display} was displaced by ${record.plugin} but ${cache} is gone — nothing to restore`)
      consumed.add(record)
    } else {
      try {
        mkdirSync(dirname(record.dest), { recursive: true })
        copyFileSync(cache, record.dest)
        lines.push(`restored your ${display} (was displaced by ${record.plugin})`)
        consumed.add(record)
      } catch (err) {
        lines.push(`cannot restore your ${display} (was displaced by ${record.plugin}): ${errorMessage(err)}`)
      }
    }
  }
  return { lines, resolved: consumed.size ? records.filter((record) => !consumed.has(record)) : null }
}
