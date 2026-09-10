// Component-file linting for `ocm validate`: command/agent markdown, skill
// SKILL.md files and plugin js modules. Frontmatter parsing is deliberately
// tolerant-but-strict — no sanitizer fallback, so YAML that only survives by
// luck is caught here instead of in the field.
import { existsSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import type { CoreDiscoveredPlugin } from "../../loader/core.js"
import { error, warning, type Finding } from "../findings"

// `commands` and `command` (likewise the other types) are both opencode-valid
// source directories, so both are searched
function locate(pluginDir: string, dirs: string[], name: string): string | null {
  for (const dir of dirs) {
    const path = join(pluginDir, dir, name)
    if (existsSync(path)) return path
  }
  return null
}

function frontmatter(content: string): { fm: string; body: string } | null {
  if (!content.startsWith("---\n")) return null
  const close = content.indexOf("\n---\n", 3)
  if (close === -1) return null
  return { fm: content.slice(4, close), body: content.slice(close + 5) }
}

// strict YAML rejects a plain scalar containing ": "; opencode's sanitizer
// rescues it, so a quoted value passes and an unquoted one is an error
function lintStrictYaml(rel: string, fm: string, findings: Finding[]): void {
  for (const line of fm.split("\n")) {
    const match = line.match(/^([^\s:]+):\s*(.*)$/)
    if (!match) continue
    const value = match[2]!
    if (value.includes(": ") && !/^["'[]/.test(value)) {
      findings.push(error(`${rel}: unquoted ": " in "${match[1]}" — strict YAML would reject this; quote the value`))
    }
  }
}

export function lintMarkdown(
  root: string,
  plugin: CoreDiscoveredPlugin,
  dirs: string[],
  file: string,
  kind: "command" | "agent",
  findings: Finding[],
): void {
  const path = locate(plugin.dir, dirs, file)
  if (!path) return
  const rel = relative(root, path)
  let content: string
  try {
    content = readFileSync(path, "utf8")
  } catch {
    return
  }
  const parsed = frontmatter(content)
  if (parsed === null) {
    findings.push(warning(`${rel}: no frontmatter — opencode requires a description`))
    return
  }
  lintStrictYaml(rel, parsed.fm, findings)
  if (!parsed.body.trim()) {
    findings.push(error(`${rel}: empty body — opencode requires the template`))
  }
  if (kind === "command" && /![a-zA-Z]/.test(parsed.body)) {
    findings.push(warning(`${rel}: "!" shell substitution — ocm info surfaces this plugin as shell-executing`))
  }
}

function lintSkillFields(
  rel: string,
  plugin: CoreDiscoveredPlugin,
  fm: string,
  skills: Map<string, string>,
  findings: Finding[],
): void {
  const values = new Map<string, string>()
  for (const line of fm.split("\n")) {
    const match = line.match(/^([^\s:]+):\s*(.*)$/)
    if (match) values.set(match[1]!, match[2]!)
  }
  const strip = (value: string | undefined) => value?.trim().replace(/^["']|["']$/g, "")
  const name = strip(values.get("name"))
  const description = strip(values.get("description"))
  if (!name) {
    findings.push(error(`${rel}: frontmatter has no "name"`))
  } else {
    const namespaced = `${plugin.name}:${name}`
    const previous = skills.get(namespaced)
    if (previous) findings.push(error(`${previous} and ${rel}: both produce "${namespaced}"`))
    else skills.set(namespaced, rel)
  }
  if (!description) {
    findings.push(error(`${rel}: frontmatter has no "description"`))
  } else if (description.length > 1024) {
    findings.push(error(`${rel}: "description" must be 1-1024 characters`))
  }
}

export function lintSkill(
  root: string,
  plugin: CoreDiscoveredPlugin,
  relDir: string,
  skills: Map<string, string>,
  findings: Finding[],
): void {
  const dir = locate(plugin.dir, ["skills", "skill"], relDir)
  if (!dir) return
  const rel = relative(root, join(dir, "SKILL.md"))
  let content: string
  try {
    content = readFileSync(join(dir, "SKILL.md"), "utf8")
  } catch {
    return
  }
  const parsed = frontmatter(content)
  if (parsed === null) {
    findings.push(error(`${rel}: no frontmatter — a skill without it is invisible`))
    return
  }
  lintStrictYaml(rel, parsed.fm, findings)
  lintSkillFields(rel, plugin, parsed.fm, skills, findings)
}

// static checks only: the failure mode in the field is a red line on every
// opencode start, so a suspicious export shape is an error, not a warning
export function lintPluginJs(root: string, plugin: CoreDiscoveredPlugin, file: string, findings: Finding[]): void {
  const path = locate(plugin.dir, ["plugin", "plugins"], file)
  if (!path) return
  const rel = relative(root, path)
  let content: string
  try {
    content = readFileSync(path, "utf8")
  } catch {
    return
  }
  if (/\btui\s*:/.test(content)) {
    findings.push(error(`${rel}: exports { id, tui } — tui plugins are not supported; ship { id, server }`))
  } else if (/\bsetup\s*:/.test(content)) {
    findings.push(error(`${rel}: exports { id, setup } — opencode silently rejects it; ship { id, server }`))
  } else if (!/\bserver\s*:/.test(content) && !/export\s+default\s+(async\s+)?[(f]/.test(content)) {
    findings.push(error(`${rel}: does not default-export { id, server } or a function`))
  }
}
