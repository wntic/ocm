// spec 13: the second half of the one-shot migration, run by every ocm command
// before dispatch. The file moves live in migrateLegacyLayout (spec 01) and
// stay byte-preserving so a programmatic installLoader keeps its spec 01
// semantics; this half upgrades what later specs changed in place — the
// registry schema (02), the sync stamp (08) and the skill link layout (03) —
// and is deliberately not called from installLoader.
import { existsSync, readFileSync, readdirSync, readlinkSync, rmSync } from "node:fs"
import { join } from "node:path"
import { componentRoot, enabledPlugins, materialize } from "../loader/core.js"
import { OCM_LINKS_DIR, OCM_REGISTRY_FILE, OCM_STAMP_FILE, OPENCODE_AGENTS_DIR, OPENCODE_COMMANDS_DIR } from "./paths"
import { loadRegistry, loadRegistryForWrite, saveRegistry } from "./registry"
import { reportUpgrade, reportWarnings } from "./report"
import type { Registry } from "./types"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// registry version 1 → 2 on disk: normalization fills the v2 defaults and
// rewrites absolute sources marketplace-relative (spec 02)
function upgradeRegistry(): void {
  const { registry, wasV1 } = loadRegistryForWrite()
  if (!wasV1) return
  saveRegistry(registry)
  reportUpgrade(true)
}

// the pre-08 global throttle stamp folds into per-marketplace lastSync (spec 08)
function foldSyncStamp(): void {
  let at: string | null = null
  try {
    const stamp: unknown = JSON.parse(readFileSync(OCM_STAMP_FILE, "utf8"))
    if (isRecord(stamp) && typeof stamp.at === "string") at = stamp.at
  } catch {
    return
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(OCM_REGISTRY_FILE, "utf8"))
  } catch {
    return
  }
  const entries = isRecord(raw) && isRecord(raw.marketplaces) ? Object.values(raw.marketplaces).filter(isRecord) : []
  const open = entries.filter((entry) => entry.lastSync == null)
  rmSync(OCM_STAMP_FILE, { force: true })
  if (!at || !open.length) return
  for (const entry of open) entry.lastSync = { at, ok: true, error: null }
  saveRegistry(raw as Registry)
  console.log(`folded ${OCM_STAMP_FILE} into per-marketplace lastSync`)
}

// a top-level symlink in the skills dir is the pre-spec-03 whole-dir form; it
// is ours iff it points into this marketplace (raw prefix compare — a realpath
// must never be compared against a non-canonical directory)
function legacySkillLinks(skillsDir: string, root: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(skillsDir)
  } catch {
    return []
  }
  const legacy: string[] = []
  for (const entry of entries) {
    let target: string | undefined
    try {
      target = readlinkSync(join(skillsDir, entry))
    } catch {
      continue
    }
    if (target === root || target.startsWith(`${root}/`)) legacy.push(entry)
  }
  return legacy
}

// the old → new names for one plugin's relinked skills, read back from the
// rendered mirrors materialize just wrote
function skillMapping(skillsDir: string, plugin: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(skillsDir)
  } catch {
    return []
  }
  const lines: string[] = []
  for (const entry of entries) {
    if (!entry.startsWith(`${plugin}--`)) continue
    let name: string | undefined
    try {
      name = readFileSync(join(skillsDir, entry, "SKILL.md"), "utf8").match(/^name: "(.+)"$/m)?.[1]
    } catch {}
    if (name) lines.push(`relinked skill ${name.slice(plugin.length + 1)} -> ${name}`)
  }
  return lines.sort()
}

// whole-dir skill symlinks and ocm--<mp> containers both predate spec 03; one
// materialize pass — the same code path an ocm update runs — replaces them
// with the current layout
function relinkSkills(): void {
  for (const [name, entry] of Object.entries(loadRegistry().marketplaces)) {
    const root = componentRoot(entry)
    const skillsDir = join(OCM_LINKS_DIR, name, "skills")
    const legacy = legacySkillLinks(skillsDir, root)
    const container =
      existsSync(join(OPENCODE_COMMANDS_DIR, `ocm--${name}`)) || existsSync(join(OPENCODE_AGENTS_DIR, `ocm--${name}`))
    if (!legacy.length && !container) continue
    const links = materialize(name, root, { enabled: enabledPlugins(entry, root) })
    reportWarnings(links.warnings.map((warning) => `${name}: ${warning}`))
    for (const plugin of legacy) for (const line of skillMapping(skillsDir, plugin)) console.log(line)
  }
}

export function migrateInstallation(): void {
  upgradeRegistry()
  foldSyncStamp()
  relinkSkills()
}
