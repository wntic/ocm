// spec 12 `ocm validate`: lint a marketplace repo for its author. Structure
// checks live here; component-file checks (markdown, skills, plugin js) are in
// validate-files.ts.
import { existsSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"
import { dirClashes, discoverPlugins, lintCrossTool } from "../../loader/core.js"
import type { CoreDiscoveredPlugin } from "../../loader/core.js"
import { error, reportFindings, warning, type Finding } from "../findings"
import { NAME_RE, lintMarketplaceJson, lintMcpJson, lintPluginJson, type MarketplaceManifest } from "../manifest-lint"
import { lintMarkdown, lintPluginJs, lintSkill } from "./validate-files"

const TYPO_FILES = new Set(["plugin.ts", "SKILLS.md", "Skill.md"])

export function validate(path?: string): void {
  const root = path ?? process.cwd()
  if (!existsSync(root)) throw new Error(`marketplace directory "${root}" does not exist`)
  console.log(`validate ${root}`)
  const findings: Finding[] = []
  const manifest = lintMarketplaceJson(root, findings)
  const skills = new Map<string, string>()
  for (const plugin of discoverPlugins(root)) {
    lintPlugin(root, plugin, manifest, skills, findings)
  }
  for (const message of lintCrossTool(root)) findings.push(warning(message))
  if (reportFindings(findings)) process.exitCode = 1
}

function lintPlugin(
  root: string,
  plugin: CoreDiscoveredPlugin,
  manifest: MarketplaceManifest,
  skills: Map<string, string>,
  findings: Finding[],
): void {
  const rel = relative(root, plugin.dir) || "."
  if (!NAME_RE.test(plugin.name)) findings.push(error(`${rel}: directory name must match ${NAME_RE}`))
  if (plugin.name.length > 64) findings.push(error(`${rel}: directory name is longer than 64 characters`))
  for (const clash of dirClashes(plugin.dir)) {
    findings.push(error(`${rel}: ${clash} — both produce the same materialized name`))
  }
  lintTypos(rel, plugin.dir, findings)
  const record = lintPluginJson(root, plugin.dir, plugin.name, findings)
  lintMcpJson(root, plugin.dir, findings)
  const entry = manifest.entries.get(plugin.name)
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
  for (const file of plugin.components.plugin ?? []) {
    lintPluginJs(root, plugin, file, findings)
  }
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
