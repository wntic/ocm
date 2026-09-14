// spec 12 `ocm validate`: lint a marketplace repo for its author. Structure
// checks live here; component-file checks (markdown, skills, plugin js) are in
// validate-files.ts.
import { existsSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"
import { dirClashes, discoverPlugins, lintCrossTool } from "../../loader/core.js"
import type { CoreDiscoveredPlugin } from "../../loader/core.js"
import { error, reportFindings, warning, type Finding } from "../findings"
import { NAME_RE, lintMarketplaceJson, lintMcpJson, lintPluginJson, lintSkillDepth, type MarketplaceManifest } from "../manifest-lint"
import { lintMarkdown, lintPluginJs, lintSkill } from "./validate-files"

const TYPO_FILES = new Set(["plugin.ts", "SKILLS.md", "Skill.md"])

// spec 14 §3: the Agent Plugins name charset — a-z 0-9 - ., alphanumeric at
// both ends, 1–64 chars
const AP_NAME_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/

export function validate(path?: string): void {
  const root = path ?? process.cwd()
  if (!existsSync(root)) throw new Error(`marketplace directory "${root}" does not exist`)
  console.log(`validate ${root}`)
  const findings: Finding[] = []
  const manifest = lintMarketplaceJson(root, findings)
  const skills = new Map<string, string>()
  const plugins = discoverPlugins(root)
  for (const plugin of plugins) {
    lintPlugin(root, plugin, manifest, skills, findings)
  }
  lintComponentCollisions(root, plugins, findings)
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
  const record = lintPluginJson(root, plugin.dir, plugin.name, findings)
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
