// spec 12 `ocm validate`: lint a marketplace repo for its author. Structure
// checks live here; component-file checks (markdown, skills, plugin js) are in
// validate-files.ts.
import { existsSync, readdirSync } from "node:fs"
import { basename, dirname, join, relative } from "node:path"
import { dirClashes, discoverPlugins, foldedComponentGroups, foldedDirPairs, lintCrossTool, marketplaceManifestFile } from "../../loader/core.js"
import type { CoreDiscoveredPlugin } from "../../loader/core.js"
import { error, reportFindings, warning, type Finding } from "../findings"
import { NAME_RE, lintMarketplaceJson, lintMcpJson, lintPluginJson, lintSkillDepth, type MarketplaceManifest } from "../manifest-lint"
import { lintMarkdown, lintPluginJs, lintSkill } from "./validate-files"

const TYPO_FILES = new Set(["plugin.ts", "SKILLS.md", "Skill.md"])

// spec 14 §3: the Agent Plugins name charset — a-z 0-9 - ., alphanumeric at
// both ends, 1–64 chars
const AP_NAME_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/

// spec 24 §1: a marketplace root has a plugins/ directory or a manifest at
// either location (spec 15) — an empty plugins/ still counts (spec 19)
function marketplaceRoot(start: string): string | null {
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "plugins")) || existsSync(marketplaceManifestFile(dir))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
  }
}

export function validate(path?: string): void {
  const start = path ?? process.cwd()
  if (!existsSync(start)) throw new Error(`marketplace directory "${start}" does not exist`)
  const root = marketplaceRoot(start)
  if (!root) {
    throw new Error(
      "error: not an ocm marketplace directory (no plugins/ and no manifest found)\n" +
        "  run ocm validate at the marketplace repository root",
    )
  }
  if (root !== start) console.log(`validating ${root}`)
  console.log(`validate ${root}`)
  const findings: Finding[] = []
  const manifest = lintMarketplaceJson(root, findings)
  const skills = new Map<string, string>()
  const plugins = discoverPlugins(root)
  for (const plugin of plugins) {
    lintPlugin(root, plugin, manifest, skills, findings)
  }
  lintComponentCollisions(root, plugins, findings)
  lintCaseFolds(root, plugins, findings)
  for (const message of lintCrossTool(root)) findings.push(warning(message))
  if (reportFindings(findings)) process.exitCode = 1
}

// spec 18: two plugins in one marketplace shipping the same command or
// agent basename is an authoring error first-come-wins would otherwise
// resolve silently at the user's expense
function lintComponentCollisions(root: string, plugins: CoreDiscoveredPlugin[], findings: Finding[]): void {
  const owners = new Map<string, string>()
  for (const plugin of plugins) {
    for (const type of ["command", "agent"] as const) {
      for (const file of plugin.components[type] ?? []) {
        const first = owners.get(`${type}/${file}`)
        if (first === undefined) owners.set(`${type}/${file}`, plugin.name)
        else {
          findings.push(
            error(`${relative(root, plugin.dir)}: ${type} "${file}" is also shipped by plugin "${first}" — rename one`),
          )
        }
      }
    }
  }
}

// brief 28 §4: two names that differ only in case install to one link name —
// a name-level rule, so it fires on every filesystem
function lintCaseFolds(root: string, plugins: CoreDiscoveredPlugin[], findings: Finding[]): void {
  for (const pair of foldedDirPairs(plugins.map((plugin) => basename(plugin.dir)))) {
    findings.push(
      error(`plugins/${pair[0]} and plugins/${pair[1]} differ only in case — both install as plugin "${pair[0]!.toLowerCase()}"; rename one`),
    )
  }
  for (const plugin of plugins) {
    for (const group of foldedComponentGroups(plugin.components)) {
      const first = group.names[0]!.toLowerCase()
      const dest = group.type === "skill"
        ? `${plugin.name}--${first.split("/").join("-")}`
        : group.type === "plugin"
          ? `ocm--${plugin.name}--${first}`
          : `${plugin.name}:${first}`
      findings.push(
        error(
          `${relative(root, plugin.dir)}: plugin "${plugin.name}" ships ${group.names.join(" and ")} that differ only in case — both install as ${dest}; rename one`,
        ),
      )
    }
  }
}

function lintPlugin(
  root: string,
  plugin: CoreDiscoveredPlugin,
  manifest: MarketplaceManifest,
  skills: Map<string, string>,
  findings: Finding[],
): void {
  const rel = relative(root, plugin.dir) || "."
  if (!NAME_RE.test(plugin.name)) {
    // spec 14 §3: an AP-valid name gets the namespacing explanation, not a
    // bare regex failure — ocm's stricter rule stays
    if (AP_NAME_RE.test(plugin.name) && plugin.name.length <= 64) {
      findings.push(
        error(
          `${rel}: name "${plugin.name}" is valid Agent Plugins but not ocm — plugin names become command and agent` +
            " namespaces on disk (<plugin>:<item>.md), and a dot there is a new failure surface; rename to kebab-case",
        ),
      )
    } else {
      findings.push(error(`${rel}: directory name must match ${NAME_RE}`))
    }
  }
  if (plugin.name.length > 64) findings.push(error(`${rel}: directory name is longer than 64 characters`))
  for (const clash of dirClashes(plugin.dir)) {
    findings.push(error(`${rel}: ${clash} — both produce the same materialized name`))
  }
  lintTypos(rel, plugin.dir, findings)
  const record = lintPluginJson(root, plugin, findings)
  lintMcpJson(root, plugin.dir, findings)
  const entry = manifest.entries.get(plugin.name)
  lintMcpServersBase(root, plugin, entry, findings)
  const fromMarketplace = typeof entry?.version === "string" ? entry.version : undefined
  const fromPlugin = typeof record?.version === "string" ? record.version : undefined
  if (fromMarketplace && fromPlugin && fromMarketplace !== fromPlugin) {
    findings.push(warning(`${rel}: version disagrees — marketplace.json ${fromMarketplace}, plugin.json ${fromPlugin}`))
  }
  for (const file of plugin.components.command ?? []) {
    lintMarkdown(root, plugin, ["commands", "command"], file, "command", findings)
  }
  for (const file of plugin.components.agent ?? []) {
    lintMarkdown(root, plugin, ["agents", "agent"], file, "agent", findings)
  }
  for (const dir of plugin.components.skill ?? []) {
    lintSkill(root, plugin, dir, skills, findings)
  }
  lintSkillDepth(root, plugin.dir, plugin.components.skill ?? [], findings)
  for (const file of plugin.components.plugin ?? []) {
    lintPluginJs(root, plugin, file, findings)
  }
}

// spec 15 §3: mcpServers resolves against the plugin directory; a value
// that resolves only against the marketplace root is deprecated
function lintMcpServersBase(
  root: string,
  plugin: CoreDiscoveredPlugin,
  entry: Record<string, unknown> | undefined,
  findings: Finding[],
): void {
  const mcpServers = entry?.mcpServers
  if (typeof mcpServers !== "string" || !mcpServers.startsWith("./") || mcpServers.split("/").includes("..")) return
  const pluginFile = join(plugin.dir, mcpServers.slice(2))
  const marketplaceFile = join(root, mcpServers.slice(2))
  if (existsSync(pluginFile) || !existsSync(marketplaceFile)) return
  findings.push(
    warning(
      `${relative(root, plugin.dir)}: mcpServers "${mcpServers}" resolves only against the marketplace root — deprecated; ` +
        `expected ${relative(root, pluginFile)}, found ${relative(root, marketplaceFile)}`,
    ),
  )
}

function lintTypos(rel: string, pluginDir: string, findings: Finding[]): void {
  if (existsSync(join(pluginDir, "skills")) && existsSync(join(pluginDir, "skill"))) {
    findings.push(warning(`${rel}: both "skill" and "skills" exist — one is probably a typo`))
  }
  let names: string[]
  try {
    names = readdirSync(pluginDir)
  } catch {
    return
  }
  for (const name of names) {
    if (TYPO_FILES.has(name)) findings.push(warning(`${rel}/${name}: likely a typo — not discovered as a component`))
  }
}
