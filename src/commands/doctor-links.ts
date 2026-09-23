// spec 12 doctor: the link-layer checks — broken symlinks, drifted
// materialization and paths under directories ocm never owns. Every
// removal proves ownership first; an unowned path is reported, never touched.
import { existsSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import {
  approvedComponents,
  componentKey,
  componentRoot,
  discoverPlugins,
  enabledPlugins,
  errorMessage,
  foldedComponentGroups,
} from "../../loader/core.js"
import type { CoreRegistry } from "../../loader/core.js"
import { materializeLinks } from "../install"
import { HOME, OCM_CACHE_DIR, OCM_LINKS_DIR, OPENCODE_AGENTS_DIR, OPENCODE_COMMANDS_DIR, OPENCODE_GLOBAL_CONFIG, OPENCODE_PLUGINS_DIR } from "../paths"
import { error, fixed, type Finding } from "../findings"

function errText(err: unknown): string {
  return errorMessage(err)
}

// raw-string prefix compare only: a raw symlink target must never be compared
// against a realpath'd directory (macOS puts temp dirs behind /var)
function insideDir(target: string, dir: string): boolean {
  return target === dir || target.startsWith(dir + "/")
}

// spec 17 stores local marketplace dirs post-realpath while a symlink target
// keeps whatever spelling created it, so the raw compare alone can disown a
// link that resolves inside a managed root: resolve the target's deepest
// existing ancestor before giving up on it
function resolvesInside(target: string, dir: string): boolean {
  if (insideDir(target, dir)) return true
  let ancestor = dirname(target)
  for (;;) {
    try {
      return insideDir(join(realpathSync(ancestor), relative(ancestor, target)), dir)
    } catch {
      const parent = dirname(ancestor)
      if (parent === ancestor) return false
      ancestor = parent
    }
  }
}

function managedRoots(registry: CoreRegistry): string[] {
  return Object.values(registry.marketplaces).map((entry) => componentRoot(entry))
}

export function removePath(path: string, findings: Finding[]): void {
  try {
    rmSync(path, { force: true, recursive: true })
    findings.push(fixed(`${path}: removed`))
  } catch (err) {
    findings.push(error(`${path}: cannot remove — ${errText(err)}`))
  }
}

export function checkBrokenLinks(registry: CoreRegistry, findings: Finding[], fix: boolean): void {
  const managed = managedRoots(registry)
  // brief 43 §4: an interrupted migration leaves links targeting the old
  // clone path of a marketplace the registry still names — the exact links
  // repointSymlinks re-points. They are ocm's for the label, but --fix
  // repairs them through re-materialization, not removal.
  const oldLayout = Object.keys(registry.marketplaces).map((name) => join(OCM_CACHE_DIR, "marketplaces", name))
  for (const dir of [OPENCODE_COMMANDS_DIR, OPENCODE_AGENTS_DIR, OPENCODE_PLUGINS_DIR]) {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      const path = join(dir, name)
      let target: string
      try {
        target = readlinkSync(path)
      } catch {
        continue
      }
      if (existsSync(path)) continue
      const ocms = managed.some((root) => resolvesInside(target, root))
      const moved = oldLayout.some((root) => insideDir(target, root))
      if (!ocms && !moved) {
        findings.push(error(`${path}: broken symlink → ${target} (not ocm's, left in place)`))
      } else if (ocms && fix) {
        removePath(path, findings)
      } else {
        findings.push(error(`${path}: broken symlink → ${target}`))
      }
    }
  }
}

// a skill mirror exists only when the source SKILL.md renders (has a name in
// its frontmatter); one that does not is legitimately skipped by materialize
function skillRenders(source: string): boolean {
  try {
    const content = readFileSync(join(source, "SKILL.md"), "utf8")
    if (!content.startsWith("---\n")) return false
    const close = content.indexOf("\n---\n", 3)
    if (close === -1) return false
    return /^name:[^\n]*\S/m.test(content.slice(4, close))
  } catch {
    return false
  }
}

// plugin-js links and mcp keys are trust-gated, so their absence is not drift
export function checkMaterialized(registry: CoreRegistry, findings: Finding[], fix: boolean): void {
  for (const [name, entry] of Object.entries(registry.marketplaces)) {
    const root = componentRoot(entry)
    if (!existsSync(root)) continue
    const enabled = enabledPlugins(entry, root)
    let missing = 0
    for (const plugin of discoverPlugins(root)) {
      if (enabled !== null && !enabled.has(plugin.name)) continue
      if (entry.plugins[plugin.name]?.collision) continue
      for (const file of plugin.components.command ?? []) {
        if (!existsSync(join(OPENCODE_COMMANDS_DIR, `${plugin.name}:${file}`))) missing += 1
      }
      for (const file of plugin.components.agent ?? []) {
        if (!existsSync(join(OPENCODE_AGENTS_DIR, `${plugin.name}:${file}`))) missing += 1
      }
      for (const rel of plugin.components.skill ?? []) {
        const source = ["skills", "skill"].map((dir) => join(plugin.dir, dir, rel)).find((path) => existsSync(path))
        const mirror = join(OCM_LINKS_DIR, name, "skills", `${plugin.name}--${rel.split("/").join("-")}`)
        if (source && skillRenders(source) && !existsSync(join(mirror, "SKILL.md"))) missing += 1
      }
    }
    if (!missing) continue
    if (!fix) {
      findings.push(error(`marketplace "${name}": ${missing} materialized component(s) missing (ocm update)`))
      continue
    }
    // brief 38 §2: the count comes from what the materializer did, not from
    // the pre-state — a skipped outcome is a warning, not a write
    const report = materializeLinks(name, entry)
    const created = report.outcomes.filter((outcome) => outcome.state === "created").length
    if (created > 0) {
      findings.push(fixed(`marketplace "${name}": re-materialized ${created} component(s) (restart opencode to activate)`))
    }
  }
}

// brief 31 §8: a record naming a component with no materialization and no
// blocked reason is a stale record — the pre-brief-31 discovery-derived
// shape frozen in the file. The first mutation rewrites the record from its
// outcomes, so the remedy is ocm update; --fix has no separate action.
export function checkStaleRecords(registry: CoreRegistry, findings: Finding[]): void {
  // undefined: not read yet; null: unreadable — checkConfig reports that, and
  // the mcp checks skip rather than guess
  let mcpKeys: Set<string> | null | undefined
  const mcpPresent = (key: string): boolean => {
    if (mcpKeys === undefined) {
      mcpKeys = null
      try {
        const parsed: unknown = JSON.parse(readFileSync(OPENCODE_GLOBAL_CONFIG, "utf8"))
        const mcp = (parsed as { mcp?: unknown } | null)?.mcp
        if (typeof mcp === "object" && mcp !== null && !Array.isArray(mcp)) {
          mcpKeys = new Set(Object.keys(mcp as Record<string, unknown>))
        }
      } catch {}
    }
    return mcpKeys !== null && mcpKeys.has(key)
  }
  for (const [name, entry] of Object.entries(registry.marketplaces)) {
    const root = componentRoot(entry)
    if (!existsSync(root)) continue
    const approved = approvedComponents(root, entry)
    for (const [plugin, record] of Object.entries(entry.plugins ?? {})) {
      // an uninstalled plugin keeps its discovery-derived components, and a
      // collision never materializes by design
      if (!record || record.enabled === false || record.collision) continue
      for (const type of ["command", "agent", "skill", "plugin", "mcp"] as const) {
        const components = record.components?.[type]
        if (!Array.isArray(components)) continue
        for (const component of components) {
          const dest =
            type === "command" ? join(OPENCODE_COMMANDS_DIR, `${plugin}:${component}`)
            : type === "agent" ? join(OPENCODE_AGENTS_DIR, `${plugin}:${component}`)
            : type === "skill" ? join(OCM_LINKS_DIR, name, "skills", `${plugin}--${component.split("/").join("-")}`, "SKILL.md")
            : type === "plugin" ? join(OPENCODE_PLUGINS_DIR, `ocm--${plugin}--${component}`)
            : `ocm--${plugin}--${component}`
          if (type === "mcp" ? mcpPresent(dest) : existsSync(dest)) continue
          // a withheld executable component has a blocked reason, not a stale one
          if (approved.get(componentKey(type, plugin, component)) === false) continue
          findings.push(
            error(
              `marketplace "${name}": plugin "${plugin}" records ${type} "${component}" with no materialization — stale record (ocm update ${name})`,
            ),
          )
        }
      }
    }
  }
}

// brief 28 §4: a registry written by an older ocm may record a folded pair —
// the link serves one of the two names, so the pair is reported and the
// link left alone (removing it would uninstall a working command)
export function checkFoldedRecords(registry: CoreRegistry, findings: Finding[]): void {
  for (const [name, entry] of Object.entries(registry.marketplaces)) {
    for (const [plugin, record] of Object.entries(entry.plugins)) {
      for (const group of foldedComponentGroups(record.components)) {
        const first = group.names[0]!.toLowerCase()
        const dest = group.type === "skill"
          ? `${plugin}--${first.split("/").join("-")}`
          : group.type === "plugin"
            ? `ocm--${plugin}--${first}`
            : `${plugin}:${first}`
        findings.push(
          error(
            `marketplace "${name}": plugin "${plugin}" ships ${group.names.join(" and ")} that differ only in case — both install as ${dest}; rename one in the marketplace`,
          ),
        )
      }
    }
  }
}

// spec 04: ocm never writes under ~/.claude or ~/.agents; an ocm-created
// symlink there should be impossible, so it is reported loudly
// spec 00: opencode also scans .claude / .agents directories walking up
// from cwd, so those bases are checked alongside the home ones
function forbiddenBases(): Set<string> {
  const bases = new Set([join(HOME, ".claude"), join(HOME, ".agents")])
  let dir = process.cwd()
  for (;;) {
    bases.add(join(dir, ".claude"))
    bases.add(join(dir, ".agents"))
    const parent = dirname(dir)
    if (parent === dir) return bases
    dir = parent
  }
}

export function checkForbiddenPaths(registry: CoreRegistry, findings: Finding[]): void {
  const managed = [...managedRoots(registry), OCM_LINKS_DIR]
  for (const base of forbiddenBases()) {
    let paths: string[]
    try {
      paths = readdirSync(base, { recursive: true }) as string[]
    } catch {
      continue
    }
    for (const rel of paths) {
      const path = join(base, rel)
      let target: string
      try {
        target = readlinkSync(path)
      } catch {
        continue
      }
      if (managed.some((root) => insideDir(target, root))) {
        findings.push(error(`${path}: ocm-created path under a directory ocm never owns — report this bug`))
      }
    }
  }
}
