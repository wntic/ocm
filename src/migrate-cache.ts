// brief 38: the one-time move of an old-layout cache (~/.cache/ocm/…, no
// root segment) into the active root's namespace. It runs in the same locked
// block as the other migrations, strictly after migrateInstallation, and the
// order is forced twice: foldSyncStamp must consume the global stamp while it
// still sits at the path OCM_STAMP_FILE reads, and relinkSkills must print
// the pre-spec-03 skill mapping from the old-layout symlinks before the old
// layout moves.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  rmdirSync,
  symlinkSync,
} from "node:fs"
import type { Dirent } from "node:fs"
import { dirname, join } from "node:path"
import { readRegistry, writeJsonAtomic } from "../loader/core.js"
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

// the stamp moves with the rest but never counts as the old layout: it is not
// proof anyone references the cache
const OLD_ITEMS = ["marketplaces", "links", "displaced", "displaced-records.json"]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// must agree with migrateLegacyCache exactly: the old layout on disk plus the
// active root's registry referencing it. Tolerant read — a corrupt registry
// cannot reference anything and must not throw here.
export function cacheMigrationNeeded(): boolean {
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
// later run forever, so it is taken down, not moved. Only for names the
// registry knows — an unknown name's links are not ours to touch.
function takeDownLegacySkillLinks(): void {
  const root = join(OCM_CACHE_DIR, "marketplaces")
  for (const name of Object.keys(readRegistry().marketplaces)) {
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

export function migrateLegacyCache(): void {
  if (!cacheMigrationNeeded()) return
  takeDownLegacySkillLinks()
  for (const item of [...OLD_ITEMS, "last-sync.json"]) {
    const from = join(OCM_CACHE_DIR, item)
    if (!existsSync(from)) continue
    const to = join(OCM_ROOT_CACHE_DIR, item)
    if (moveItem(from, to)) console.log(`moved ${from} -> ${to}`)
  }
  rewriteRegistryDirs()
  rewriteSkillsPaths()
  rewriteDisplacedRecords()
  repointSymlinks()
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
