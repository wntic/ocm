// spec 12 doctor: the link-layer checks — stray ocm files, broken symlinks,
// drifted materialization and paths under directories ocm never owns. Every
// removal proves ownership first; an unowned path is reported, never touched.
import { existsSync, readFileSync, readdirSync, readlinkSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { componentRoot, discoverPlugins, enabledPlugins } from "../../loader/core.js"
import type { CoreRegistry } from "../../loader/core.js"
import { materializeLinks } from "../install"
import { HOME, OCM_LINKS_DIR, OPENCODE_AGENTS_DIR, OPENCODE_COMMANDS_DIR, OPENCODE_PLUGINS_DIR } from "../paths"
import { error, fixed, type Finding } from "../findings"

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// raw-string prefix compare only: a raw symlink target must never be compared
// against a realpath'd directory (macOS puts temp dirs behind /var)
function insideDir(target: string, dir: string): boolean {
  return target === dir || target.startsWith(dir + "/")
}

function managedRoots(registry: CoreRegistry): string[] {
  return Object.values(registry.marketplaces).map((entry) => componentRoot(entry))
}

function removePath(path: string, findings: Finding[]): void {
  try {
    rmSync(path, { force: true, recursive: true })
    findings.push(fixed(`${path}: removed`))
  } catch (err) {
    findings.push(error(`${path}: cannot remove — ${errText(err)}`))
  }
}

// spec 01: no ocm file other than ocm-loader.js may live in plugins/
export function checkStrays(registry: CoreRegistry, findings: Finding[], fix: boolean): void {
  const claimed = new Set<string>()
  for (const entry of Object.values(registry.marketplaces)) {
    for (const [name, plugin] of Object.entries(entry.plugins ?? {})) {
      for (const file of plugin.components?.plugin ?? []) claimed.add(`ocm--${name}--${file}`)
    }
  }
  let entries: string[]
  try {
    entries = readdirSync(OPENCODE_PLUGINS_DIR)
  } catch {
    return
  }
  for (const name of entries) {
    if (!name.startsWith("ocm--") || claimed.has(name)) continue
    const path = join(OPENCODE_PLUGINS_DIR, name)
    if (fix) removePath(path, findings)
    else findings.push(error(`${path}: stray ocm file — no registry entry owns it`))
  }
}

export function checkBrokenLinks(registry: CoreRegistry, findings: Finding[], fix: boolean): void {
  const managed = managedRoots(registry)
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
      if (!managed.some((root) => insideDir(target, root))) {
        findings.push(error(`${path}: broken symlink → ${target} (not ocm's, left in place)`))
      } else if (fix) {
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
    materializeLinks(name, entry)
    findings.push(fixed(`marketplace "${name}": re-materialized ${missing} component(s) (restart opencode to activate)`))
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
