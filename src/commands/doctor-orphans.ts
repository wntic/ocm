// spec 20 doctor: the orphan sweep — ocm-- links and skill mirrors with no
// registry backing (F30), <plugin>:<file> links in commands/ and agents/
// (brief 33 §1), single-dash strays opencode loads on every start
// (F26), and the trust safety net that keeps an approved link from ever being
// removed as stray, even when the records lag (F8).
import { existsSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs"
import { join } from "node:path"
import { displacedRecords, setSkillsPath } from "../../loader/core.js"
import type { CoreRegistry } from "../../loader/core.js"
import { OCM_DISPLACED_DIR, OCM_DISPLACED_RECORD_FILE, OCM_LINKS_DIR, OCM_LOADER_NAME, OCM_REGISTRY_FILE, OPENCODE_AGENTS_DIR, OPENCODE_COMMANDS_DIR, OPENCODE_PLUGINS_DIR } from "../paths"
import { error, fixed, warning, type Finding } from "../findings"
import { insideRegisteredRoot, ocmOwned, removePath } from "./doctor-links"

// brief 33 §2 (F85): a run that cannot read the registry must not promise a
// removal it would not perform — the finding names the registry repair instead
function cannotVerifyOwnership(path: string, findings: Finding[]): void {
  findings.push(
    error(
      `${path}: cannot verify ownership — the registry is unreadable (see the error above)\n` +
        `    fix ${OCM_REGISTRY_FILE}, then run ocm doctor --fix`,
    ),
  )
}

// spec 20 §2.3: a link matching a trust-approved component of a registered
// plugin is never stray — the records may lag the trust state
function trustedPluginLinks(registry: CoreRegistry): Set<string> {
  const trusted = new Set<string>()
  for (const entry of Object.values(registry.marketplaces)) {
    if (entry.trust.code !== "granted") continue
    for (const rel of Object.keys(entry.trust.components ?? {})) {
      const match = /^plugins\/([^/]+)\/plugins?\/(.+)$/.exec(rel)
      if (match && entry.plugins[match[1]!]) trusted.add(`ocm--${match[1]}--${match[2]}`)
    }
  }
  return trusted
}

export function checkStrays(registry: CoreRegistry, findings: Finding[], fix: boolean, registryUsable: boolean): void {
  const claimed = new Set<string>()
  for (const entry of Object.values(registry.marketplaces)) {
    for (const [name, plugin] of Object.entries(entry.plugins ?? {})) {
      for (const file of plugin.components?.plugin ?? []) claimed.add(`ocm--${name}--${file}`)
    }
  }
  const trusted = trustedPluginLinks(registry)
  let entries: string[]
  try {
    entries = readdirSync(OPENCODE_PLUGINS_DIR)
  } catch {
    return
  }
  for (const name of entries) {
    const path = join(OPENCODE_PLUGINS_DIR, name)
    if (name.startsWith("ocm--")) {
      if (claimed.has(name)) continue
      // broken links are checkBrokenLinks's to report, once
      if (!existsSync(path)) continue
      if (trusted.has(name)) {
        findings.push(error(`${path}: registry records are stale — run ocm update`))
      } else if (!registryUsable) {
        cannotVerifyOwnership(path, findings)
      } else if (fix) {
        removePath(path, findings)
      } else {
        findings.push(error(`${path}: no marketplace owns this link (orphaned by a loader uninstall?) — ocm doctor --fix removes it`))
      }
      continue
    }
    // single dash: matches no ocm layout, but opencode still loads it
    if (name !== OCM_LOADER_NAME && /^ocm-.*\.(js|ts)$/.test(name)) {
      findings.push(warning(`${path} looks like an ocm file but matches no ocm layout — opencode loads it on every start; remove or rename it`))
    }
  }
}

// brief 33 §1 change 2: the orphan sweep for <plugin>:<file> links in
// commands/ and agents/ — live links no verb can remove once the registry
// record is gone. Only symlinks enter; broken ones are checkBrokenLinks's
export function checkOrphanLinks(registry: CoreRegistry, findings: Finding[], fix: boolean, registryUsable: boolean): void {
  const claimed = new Set<string>()
  for (const entry of Object.values(registry.marketplaces)) {
    for (const plugin of Object.keys(entry.plugins ?? {})) claimed.add(plugin)
  }
  for (const dir of [OPENCODE_COMMANDS_DIR, OPENCODE_AGENTS_DIR]) {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      const colon = name.indexOf(":")
      if (colon <= 0 || colon === name.length - 1) continue
      const path = join(dir, name)
      let target: string
      try {
        target = readlinkSync(path)
      } catch {
        continue
      }
      if (!existsSync(path)) continue
      if (claimed.has(name.slice(0, colon))) continue
      // change 5: a link into a registered marketplace's root is never an
      // orphan, whatever the per-plugin records say
      if (insideRegisteredRoot(target, registry)) {
        findings.push(error(`${path}: registry records are stale — run ocm update`))
      } else if (ocmOwned(path, target, registry)) {
        if (!registryUsable) cannotVerifyOwnership(path, findings)
        else if (fix) removePath(path, findings)
        else findings.push(error(`${path}: no marketplace owns this link → ${target} — ocm doctor --fix removes it`))
      } else {
        findings.push(error(`${path}: symlink → ${target} ; no marketplace owns it and the target is not ocm's — remove it by hand, or re-add the marketplace`))
      }
    }
  }
}

// spec 20 F30: skill mirrors under the ocm links dir of an unregistered
// marketplace — the links tree is ocm's cache, so nothing there is the
// user's; the skills.paths entry is cleaned alongside the mirrors
export function checkOrphanMirrors(registry: CoreRegistry, findings: Finding[], fix: boolean, registryUsable: boolean): void {
  let names: string[]
  try {
    names = readdirSync(OCM_LINKS_DIR)
  } catch {
    return
  }
  const registered = new Set(Object.keys(registry.marketplaces))
  for (const name of names) {
    if (registered.has(name)) continue
    const tree = join(OCM_LINKS_DIR, name)
    const skillsDir = join(tree, "skills")
    let mirrors: string[]
    try {
      mirrors = readdirSync(skillsDir)
    } catch {
      // brief 33 §1 change 4: with no skills dir the tree itself is the
      // orphan — the links tree is ocm's by the predicate's clause (c)
      mirrors = []
    }
    if (!mirrors.length) {
      if (!registryUsable) cannotVerifyOwnership(tree, findings)
      else if (fix) removePath(tree, findings)
      else findings.push(error(`${tree}: no marketplace owns this link (orphaned by a loader uninstall?) — ocm doctor --fix removes it`))
    }
    for (const mirror of mirrors) {
      const path = join(skillsDir, mirror)
      if (!registryUsable) cannotVerifyOwnership(path, findings)
      else if (fix) removePath(path, findings)
      else findings.push(error(`${path}: no marketplace owns this link (orphaned by a loader uninstall?) — ocm doctor --fix removes it`))
    }
    if (!fix || !registryUsable) continue
    const outcome = setSkillsPath(skillsDir, false)
    if (outcome.state === "skipped" || outcome.state === "failed") findings.push(error(outcome.reason!))
    else if (outcome.state === "wrote") findings.push(fixed(`${skillsDir}: removed from skills.paths`))
    rmSync(tree, { recursive: true, force: true })
  }
}

// spec 21: a live displacement is normal state, not drift — one
// informational line. A <ts> directory no record points at is a pre-21
// removal's leftover: named, never deleted (the files are the user's)
export function checkDisplaced(registry: CoreRegistry, findings: Finding[]): void {
  // spec 27 §2: an unreadable records file is reported, never auto-repaired —
  // ocm cannot prove which cache copy belongs where
  if (existsSync(OCM_DISPLACED_RECORD_FILE)) {
    let parses = false
    try {
      parses = Array.isArray(JSON.parse(readFileSync(OCM_DISPLACED_RECORD_FILE, "utf8")))
    } catch {}
    if (!parses) {
      findings.push(
        error(
          `${OCM_DISPLACED_RECORD_FILE}: not valid JSON — displaced originals cannot be restored\n` +
            `    the copies are still under ${OCM_DISPLACED_DIR}; move them back by hand, then delete the records file`,
        ),
      )
    }
  }
  const records = displacedRecords()
  const live = records.filter((record) => registry.marketplaces[record.marketplace])
  if (live.length) {
    console.log(`  displaced  ${live.length} original${live.length === 1 ? "" : "s"} in ${OCM_DISPLACED_DIR}`)
  }
  let entries: string[]
  try {
    entries = readdirSync(OCM_DISPLACED_DIR)
  } catch {
    return
  }
  const known = new Set(records.map((record) => record.dir))
  for (const entry of entries) {
    const path = join(OCM_DISPLACED_DIR, entry)
    if (!known.has(path)) {
      findings.push(warning(`${path}: displaced copy with no record (removed by an older ocm?) — restore or remove it by hand`))
    }
  }
}
