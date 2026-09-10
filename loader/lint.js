import { existsSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { discoverPlugins } from "./discovery.js"

// spec 11: the portable skill frontmatter subset. opencode tolerates extras
// today, so this is a lint, not a rule — it exists so a plugin does not
// become a liability if that tolerance regresses.
const PORTABLE_KEYS = new Set(["name", "description", "license", "compatibility", "metadata"])

// top-level keys only: an indented line belongs to the value above it
function frontmatterKeys(content) {
  if (!content.startsWith("---\n")) return []
  const close = content.indexOf("\n---\n", 3)
  if (close === -1) return []
  const keys = []
  for (const line of content.slice(4, close).split("\n")) {
    const match = line.match(/^[^\s:]+(?=:)/)
    if (match) keys.push(match[0])
  }
  return keys
}

// `commands` and `command` (likewise the other types) are both opencode-valid
// source directories, so both are searched
function sourceFile(pluginDir, dirs, name) {
  for (const dir of dirs) {
    const file = join(pluginDir, dir, name)
    if (existsSync(file)) return file
  }
  return null
}

// CLAUDE_PLUGIN_ROOT is the marketplace root, so a reference resolves only
// when the plugins/<name>/ segment is written out (spec 11)
function lintPluginRootRefs(plugin, dirs, files, marketplaceDir, warnings) {
  for (const name of files ?? []) {
    const file = sourceFile(plugin.dir, dirs, name)
    if (!file) continue
    let content
    try {
      content = readFileSync(file, "utf8")
    } catch {
      continue
    }
    for (const match of content.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}([^"\s]*)/g)) {
      if (!match[1].startsWith("/plugins/")) {
        warnings.push(
          `${relative(marketplaceDir, file)}: \${CLAUDE_PLUGIN_ROOT}${match[1]} will not resolve` +
            " — CLAUDE_PLUGIN_ROOT is the marketplace root, write the plugins/<name>/ segment out",
        )
      }
    }
  }
}

// spec 11 phase 1: the cross-tool lint that `ocm validate` (spec 12) renders.
// Warnings only — an install never fails on a finding.
export function lintCrossTool(marketplaceDir) {
  const warnings = []
  for (const plugin of discoverPlugins(marketplaceDir)) {
    for (const rel of plugin.components.skill ?? []) {
      const file = sourceFile(plugin.dir, ["skills", "skill"], join(rel, "SKILL.md"))
      if (!file) continue
      let content
      try {
        content = readFileSync(file, "utf8")
      } catch {
        continue
      }
      for (const key of frontmatterKeys(content)) {
        if (!PORTABLE_KEYS.has(key)) {
          warnings.push(
            `${relative(marketplaceDir, file)}: non-portable frontmatter "${key}"` +
              " — outside the portable subset (name, description, license, compatibility, metadata)",
          )
        }
      }
    }
    lintPluginRootRefs(plugin, ["commands", "command"], plugin.components.command, marketplaceDir, warnings)
    lintPluginRootRefs(plugin, ["agents", "agent"], plugin.components.agent, marketplaceDir, warnings)
  }
  return warnings
}
