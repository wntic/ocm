// brief 38: the one-time move of an old-layout cache (~/.cache/ocm/…, no
// root segment) into the active root's namespace. It runs in the same locked
// block as the other migrations, strictly after migrateInstallation, and the
// order is forced twice: foldSyncStamp must consume the global stamp while it
// still sits at the path OCM_STAMP_FILE reads, and relinkSkills must print
// the pre-spec-03 skill mapping from the old-layout symlinks before the old
// layout moves.
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  symlinkSync,
} from "node:fs"
import type { Dirent } from "node:fs"
import { dirname, join } from "node:path"
import { isRenderedFile, readRegistry, writeJsonAtomic } from "../loader/core.js"
import { loadRegistryForWrite, saveRegistryIfChanged } from "./registry"
import {
  OCM_CACHE_DIR,
  OCM_DISPLACED_DIR,
  OCM_DISPLACED_RECORD_FILE,
  OCM_LINKS_DIR,
  OCM_ROOT_CACHE_DIR,
  OPENCODE_AGENTS_DIR,
  OPENCODE_COMMANDS_DIR,
  OPENCODE_GLOBAL_CONFIG,
  OPENCODE_PLUGINS_DIR,
} from "./paths"

// the stamp is copied with the rest, never moved, and never counts as the old
// layout: it is not proof anyone references the cache
const OLD_ITEMS = ["marketplaces", "links", "displaced", "displaced-records.json"]

const OLD_DISPLACED_DIR = join(OCM_CACHE_DIR, "displaced")
const OLD_DISPLACED_PREFIX = `${OLD_DISPLACED_DIR}/`

// brief 43 §1: the migration records its progress instead of inferring it
// from the rewrites' end state — a kill after the moves reads as finished
// forever, and an old loader re-creating links/<name> at the old path reads
// as never started
const MIGRATION_STATE_FILE = join(OCM_ROOT_CACHE_DIR, "cache-migration.json")

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// tolerant read: absent or unparseable reads as absent, so a corrupt state
// file falls back to the old-layout condition instead of throwing
function readMigrationState(): { state: "in-progress" | "done"; marketplaces: string[] } | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(MIGRATION_STATE_FILE, "utf8"))
  } catch {
    return undefined
  }
  if (!isRecord(raw) || (raw.state !== "in-progress" && raw.state !== "done")) return undefined
  const marketplaces = Array.isArray(raw.marketplaces) ? raw.marketplaces.filter((name): name is string => typeof name === "string") : []
  return { state: raw.state, marketplaces }
}

function writeMigrationState(state: "in-progress" | "done", marketplaces: string[]): void {
  writeJsonAtomic(MIGRATION_STATE_FILE, `${JSON.stringify({ state, marketplaces }, null, 2)}\n`)
}

// must agree with migrateLegacyCache exactly: the old layout on disk plus the
// active root's registry referencing it. Tolerant read — a corrupt registry
// cannot reference anything and must not throw here.
export function cacheMigrationNeeded(): boolean {
  // brief 43 §1: recorded state decides before the layout does — done means
  // the old layout can never re-trigger the migration, in-progress means a
  // killed run resumes however the rewrites ended
  const recorded = readMigrationState()
  if (recorded !== undefined) {
    if (recorded.state === "in-progress") return true
    // brief 43 §3: done never migrates again, but a re-created old-path
    // links tree may still be provably ours to remove — the proof runs
    // under the same lock, so it triggers the block without re-running it
    return existsSync(join(OCM_CACHE_DIR, "links"))
  }
  // The registry naming an old path is the whole condition. The moves run
  // before the rewrites, so a crash between them leaves the old directories
  // gone and the registry still pointing at them; also requiring the
  // directories to exist made that state permanent — every marketplace
  // reading as "directory missing", a git one recoverable only by re-cloning
  // and a local one not at all. On the next command the moves skip what has
  // already moved and the rewrites finish the job.
  //
  // It must not widen further: an old-layout cache *no* registry references
  // may belong to another config root, and moving it is the cross-root harm
  // this brief exists to end. reportUnreferencedOldCache handles that case.
  //
  // brief 39 §6: the dir prefix alone is not enough — a local marketplace's
  // dir is the user's own source directory and never sits under the cache,
  // so an all-local home never migrated and was warned about forever. The
  // registry-named trees are asked about directly instead: a links/<name>
  // it holds, or a displaced record naming one of its marketplaces.
  const marketplaces = readRegistry().marketplaces
  const prefix = `${join(OCM_CACHE_DIR, "marketplaces")}/`
  if (Object.values(marketplaces).some((entry) => entry.dir.startsWith(prefix))) return true
  if (Object.keys(marketplaces).some((name) => existsSync(join(OCM_CACHE_DIR, "links", name)))) return true
  let records: unknown
  try {
    records = JSON.parse(readFileSync(join(OCM_CACHE_DIR, "displaced-records.json"), "utf8"))
  } catch {
    return false
  }
  if (!Array.isArray(records)) return false
  return records.some(
    (record) => isRecord(record) && typeof record.marketplace === "string" && record.marketplace in marketplaces,
  )
}

// a pre-spec-03 whole-dir skill symlink under the old links tree. It is an
// owned relic whose mapping relinkSkills already printed in this same run;
// moving it into the namespace would re-trigger the relink migration on every
// later run forever, so it is taken down, not moved. Only for names this
// root's registry named — an unknown name's links are not ours to touch.
function takeDownLegacySkillLinks(names: string[]): void {
  const root = join(OCM_CACHE_DIR, "marketplaces")
  for (const name of names) {
    const skillsDir = join(OCM_CACHE_DIR, "links", name, "skills")
    let entries: string[]
    try {
      entries = readdirSync(skillsDir)
    } catch {
      continue
    }
    for (const entry of entries) {
      let target: string | undefined
      try {
        target = readlinkSync(join(skillsDir, entry))
      } catch {
        continue
      }
      if (target === root || target.startsWith(`${root}/`)) rmSync(join(skillsDir, entry), { force: true })
    }
  }
}

// move one old item into the namespace. A directory whose destination already
// exists — the same run's relinkSkills may have materialized mirrors there —
// merges per child; the old tree is pruned with rmdir-on-empty only, never a
// recursive delete. Returns false when nothing moved.
function moveItem(from: string, to: string): boolean {
  if (!existsSync(to)) {
    mkdirSync(dirname(to), { recursive: true })
    renameSync(from, to)
    return true
  }
  let fromDir = false
  let toDir = false
  try {
    fromDir = lstatSync(from).isDirectory()
    toDir = lstatSync(to).isDirectory()
  } catch {
    return false
  }
  if (!fromDir || !toDir) {
    console.error(`warning: left ${from} in place; ${to} already exists — move it by hand`)
    return false
  }
  for (const child of readdirSync(from)) {
    moveItem(join(from, child), join(to, child))
  }
  try {
    rmdirSync(from)
  } catch {}
  return true
}

// brief 43 §2: the clone and the links mirror move per registry name, not as
// whole directories — what remains at the old path may belong to another
// config root and is reportUnreferencedOldCache's to describe, not ours to move
function moveOwnedMarketplaces(names: string[]): void {
  for (const name of names) {
    for (const part of ["marketplaces", "links"]) {
      const from = join(OCM_CACHE_DIR, part, name)
      if (!existsSync(from)) continue
      const to = join(OCM_ROOT_CACHE_DIR, part, name)
      if (moveItem(from, to)) console.log(`moved ${from} -> ${to}`)
    }
  }
}

// brief 43 §2: a displaced record is ours by the same test the predicate
// uses — its marketplace sits in this root's registry. Our copies move and
// our records leave the old file (keeping them there would re-fire
// cacheMigrationNeeded forever); the rest may be another root's and stays.
function moveOwnedDisplaced(names: string[]): void {
  const oldFile = join(OCM_CACHE_DIR, "displaced-records.json")
  let records: unknown
  try {
    records = JSON.parse(readFileSync(oldFile, "utf8"))
  } catch {
    return
  }
  if (!Array.isArray(records)) return
  const ours: Record<string, unknown>[] = []
  const theirs: unknown[] = []
  for (const record of records) {
    if (isRecord(record) && typeof record.marketplace === "string" && names.includes(record.marketplace)) ours.push(record)
    else theirs.push(record)
  }
  if (ours.length === 0) return
  for (const record of ours) moveDisplacedCopy(record)
  appendDisplacedRecords(ours)
  if (theirs.length > 0) writeJsonAtomic(oldFile, `${JSON.stringify(theirs, null, 2)}\n`)
  else rmSync(oldFile, { force: true })
}

// move the copy one record names, then prune the emptied ancestors. A dir
// outside the old displaced prefix is a crash-window relic already naming the
// namespace — moving its copy would move it onto itself.
function moveDisplacedCopy(record: Record<string, unknown>): void {
  if (typeof record.dir !== "string" || typeof record.dest !== "string") return
  if (!record.dir.startsWith(OLD_DISPLACED_PREFIX)) return
  const dir = join(OCM_DISPLACED_DIR, record.dir.slice(OLD_DISPLACED_PREFIX.length))
  const from = join(record.dir, record.dest)
  const to = join(dir, record.dest)
  if (existsSync(from) && moveItem(from, to)) console.log(`moved ${from} -> ${to}`)
  pruneEmptiedAncestors(from)
  record.dir = dir
}

// rmdir-on-empty only, never a recursive delete: a stranger's copy in the
// same tree stops the walk, so nothing but emptied directories ever leaves
function pruneEmptiedAncestors(path: string): void {
  let dir = dirname(path)
  for (;;) {
    try {
      rmdirSync(dir)
    } catch {
      return
    }
    if (dir === OLD_DISPLACED_DIR) return
    dir = dirname(dir)
  }
}

// merge ours into the namespace records file, deduped: a crash between the
// copy move and this append re-processes the same records, and while the
// moves skip what already moved, the append must not duplicate
function appendDisplacedRecords(ours: Record<string, unknown>[]): void {
  let existing: unknown[] = []
  try {
    const parsed: unknown = JSON.parse(readFileSync(OCM_DISPLACED_RECORD_FILE, "utf8"))
    if (Array.isArray(parsed)) existing = parsed
  } catch {}
  const seen = new Set(existing.map((record) => JSON.stringify(record)))
  const added = ours.filter((record) => {
    const key = JSON.stringify(record)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (added.length > 0) writeJsonAtomic(OCM_DISPLACED_RECORD_FILE, `${JSON.stringify([...existing, ...added], null, 2)}\n`)
}

// the sync stamp is a throttle shared by every root in the old layout:
// copied, never moved — another root's early sync is cheap, a stolen throttle
// is not. A valid stamp was already consumed by foldSyncStamp; this carries
// an unconsumable one out of the shared cache, without a moved line.
function copySyncStamp(): void {
  const from = join(OCM_CACHE_DIR, "last-sync.json")
  const to = join(OCM_ROOT_CACHE_DIR, "last-sync.json")
  if (existsSync(from) && !existsSync(to)) copyFileSync(from, to)
}

function rewriteRegistryDirs(): void {
  const prefix = `${join(OCM_CACHE_DIR, "marketplaces")}/`
  const { registry } = loadRegistryForWrite()
  let changed = false
  for (const entry of Object.values(registry.marketplaces)) {
    if (entry.dir.startsWith(prefix)) {
      entry.dir = join(OCM_ROOT_CACHE_DIR, "marketplaces", entry.dir.slice(prefix.length))
      changed = true
    }
  }
  if (changed) saveRegistryIfChanged(registry)
}

// opencode.json skills.paths: every old-layout entry becomes its namespace
// path, deduped against the namespace entry relinkSkills added earlier in the
// same run. Tolerant like setSkillsPath: a config that fails to parse is
// never touched.
function rewriteSkillsPaths(): void {
  const prefix = `${join(OCM_CACHE_DIR, "links")}/`
  let raw: string | undefined
  try {
    raw = readFileSync(OPENCODE_GLOBAL_CONFIG, "utf8")
  } catch {
    return
  }
  let config: unknown
  try {
    config = JSON.parse(raw)
  } catch {}
  if (!isRecord(config)) {
    console.error(`warning: skipped ${OPENCODE_GLOBAL_CONFIG}: ${config === undefined ? "not valid JSON, left untouched" : "not a JSON object"}`)
    return
  }
  const skills = config.skills
  if (skills !== undefined && !isRecord(skills)) {
    console.error(`warning: skipped ${OPENCODE_GLOBAL_CONFIG}: "skills" is not an object`)
    return
  }
  const paths = isRecord(skills) ? skills.paths : undefined
  if (!Array.isArray(paths)) {
    if (paths !== undefined) console.error(`warning: skipped ${OPENCODE_GLOBAL_CONFIG}: "skills.paths" is not an array`)
    return
  }
  let changed = false
  const next: unknown[] = []
  for (const path of paths) {
    if (typeof path !== "string" || !path.startsWith(prefix)) {
      next.push(path)
      continue
    }
    changed = true
    const mapped = join(OCM_LINKS_DIR, path.slice(prefix.length))
    if (!next.includes(mapped) && !paths.includes(mapped)) next.push(mapped)
  }
  if (!changed) return
  const updated = { ...config, skills: { ...(isRecord(skills) ? skills : {}), paths: next } }
  writeJsonAtomic(OPENCODE_GLOBAL_CONFIG, `${JSON.stringify(updated, null, 2)}\n`)
}

// the records file now sits at its namespace location; `dir` fields follow
// the displaced tree, `dest` fields point into the config dir and stay
function rewriteDisplacedRecords(): void {
  const prefix = `${join(OCM_CACHE_DIR, "displaced")}/`
  let records: unknown
  try {
    records = JSON.parse(readFileSync(OCM_DISPLACED_RECORD_FILE, "utf8"))
  } catch {
    return
  }
  if (!Array.isArray(records)) return
  let changed = false
  for (const record of records) {
    if (isRecord(record) && typeof record.dir === "string" && record.dir.startsWith(prefix)) {
      record.dir = join(OCM_DISPLACED_DIR, record.dir.slice(prefix.length))
      changed = true
    }
  }
  if (changed) writeJsonAtomic(OCM_DISPLACED_RECORD_FILE, `${JSON.stringify(records, null, 2)}\n`)
}

// every symlink that records an absolute clone path — config-dir component
// links and mirror-internal links alike — must follow the clone into the
// namespace or the migrated install breaks silently
function repointSymlinks(): void {
  const oldPrefix = `${join(OCM_CACHE_DIR, "marketplaces")}/`
  const newPrefix = `${join(OCM_ROOT_CACHE_DIR, "marketplaces")}/`
  const repoint = (path: string): void => {
    let target: string
    try {
      target = readlinkSync(path)
    } catch {
      return
    }
    if (!target.startsWith(oldPrefix)) return
    try {
      rmSync(path, { force: true })
      symlinkSync(newPrefix + target.slice(oldPrefix.length), path)
    } catch (err) {
      console.error(`warning: failed to re-point ${path}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const walk = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isSymbolicLink()) repoint(path)
    }
  }
  walk(OPENCODE_COMMANDS_DIR)
  walk(OPENCODE_AGENTS_DIR)
  walk(OPENCODE_PLUGINS_DIR)
  walk(OCM_LINKS_DIR)
}

// brief 43 §3: a completed migration may remove a re-created old-path
// links/<name> tree only when the name is one this root's registry holds and
// every leaf proves it ours — a live symlink resolving into a clone the
// registry names, or a file carrying ocm's rendered marker. Anything that
// fails stays for reportUnreferencedOldCache to warn about; marketplaces/ and
// displaced/ at the old path are never touched here.
function removeOwnedOldLinks(): void {
  const oldLinks = join(OCM_CACHE_DIR, "links")
  let children: string[]
  try {
    children = readdirSync(oldLinks)
  } catch {
    return
  }
  const marketplaces = readRegistry().marketplaces
  const clones: string[] = []
  for (const entry of Object.values(marketplaces)) {
    try {
      clones.push(realpathSync(entry.dir))
    } catch {}
  }
  for (const child of children) {
    const tree = join(oldLinks, child)
    if (!Object.hasOwn(marketplaces, child) || !ownedLinksTree(tree, clones)) continue
    rmSync(tree, { recursive: true })
    console.log(`removed ${tree} (regenerable old-layout mirror)`)
  }
  try { rmdirSync(oldLinks) } catch {}
}

// every leaf proves it ours, and at least one leaf is seen. A mirror is
// symlinks plus rendered SKILL.md files (loader/materialize.js), so both
// count; a regular file without the marker — anything a person put there —
// fails the whole tree
function ownedLinksTree(tree: string, clones: string[]): boolean {
  let entries: Dirent[]
  try {
    entries = readdirSync(tree, { withFileTypes: true })
  } catch {
    return false
  }
  let owned = false
  for (const entry of entries) {
    const path = join(tree, entry.name)
    if (entry.isDirectory()) {
      // a passing subtree saw an owned leaf below
      if (!ownedLinksTree(path, clones)) return false
      owned = true
      continue
    }
    if (!entry.isSymbolicLink()) {
      if (!entry.isFile() || !isRenderedFile(path)) return false
      owned = true
      continue
    }
    let resolved: string
    try {
      resolved = realpathSync(path)
    } catch {
      return false
    }
    if (!clones.some((clone) => resolved === clone || resolved.startsWith(`${clone}/`))) return false
    owned = true
  }
  return owned
}

export function migrateLegacyCache(): void {
  const recorded = readMigrationState()
  if (recorded?.state === "done") {
    removeOwnedOldLinks()
    return
  }
  if (recorded === undefined && !cacheMigrationNeeded()) return
  // on resume the recorded names decide what is ours — the registry-dir
  // rewrite may already have run, so the registry can no longer attribute
  // the old layout's contents
  const names = recorded ? recorded.marketplaces : Object.keys(readRegistry().marketplaces)
  writeMigrationState("in-progress", names)
  takeDownLegacySkillLinks(names)
  moveOwnedMarketplaces(names)
  moveOwnedDisplaced(names)
  copySyncStamp()
  // prune what the per-name moves emptied — rmdir throws on non-empty, which
  // is the safety. Without it a fully-migrated home warns forever through
  // reportUnreferencedOldCache, which fires on existsSync of the old paths
  for (const part of ["marketplaces", "links", "displaced"]) {
    try { rmdirSync(join(OCM_CACHE_DIR, part)) } catch {}
  }
  rewriteRegistryDirs()
  rewriteSkillsPaths()
  rewriteDisplacedRecords()
  repointSymlinks()
  writeMigrationState("done", names)
}

// an old-layout cache no registry references is never deleted — it may belong
// to a root this invocation cannot see. Read-only, no lock; it repeats on
// every command while the condition holds, like the stranded notice.
export function reportUnreferencedOldCache(): void {
  for (const item of OLD_ITEMS) {
    const path = join(OCM_CACHE_DIR, item)
    if (existsSync(path)) console.error(`warning: ${path} left in place — it may belong to another config root`)
  }
}
