// brief 29: the one installability answer shared by add, update, scan,
// validate and the loader's auto-install. Findings are data — the gate
// never prints, never throws and never sets an exit code, and a read
// failure becomes a finding rather than an exception. No sibling imports:
// this module stays safe to load anywhere.
import { existsSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// the materialized name for each file component type; `dirs` is the
// source-directory resolution order, `plural` the fallback path
const FILE_KINDS = [
  { type: "command", dirs: ["commands", "command"], plural: "commands", installAs: (plugin, stem) => `/${plugin}:${stem}` },
  { type: "agent", dirs: ["agents", "agent"], plural: "agents", installAs: (plugin, stem) => `${plugin}:${stem}` },
  { type: "plugin", dirs: ["plugin", "plugins"], plural: "plugins", installAs: (plugin, stem, file) => `ocm--${plugin}--${file}` },
]

// brief 29 §5: a component whose materialized name is empty or dot-prefixed
// would install as "/linter:" — a finding, not a silently skipped link
function componentFindings(marketplaceDir, plugin, findings) {
  const rel = relative(marketplaceDir, plugin.dir)
  const degenerate = (path, name, installAs, rename) => findings.push({
    plugin: plugin.name,
    path,
    code: "component-degenerate",
    message: name
      ? `${path}: component name "${name}" begins with "." — it would install as "${installAs}"\n  ${rename}`
      : `${path}: component name is empty — it would install as "${installAs}"\n  ${rename}`,
  })
  for (const kind of FILE_KINDS) {
    for (const file of plugin.components[kind.type] ?? []) {
      const stem = file.slice(0, file.lastIndexOf("."))
      if (stem && !stem.startsWith(".")) continue
      const dir = kind.dirs.find((d) => existsSync(join(plugin.dir, d, file))) ?? kind.plural
      degenerate(join(rel, dir, file), stem, kind.installAs(plugin.name, stem, file),
        `rename it to <name>.${file.slice(file.lastIndexOf(".") + 1)}, or delete it`)
    }
  }
  for (const skillRel of plugin.components.skill ?? []) {
    const name = skillRel.split("/").pop()
    if (name && !name.startsWith(".")) continue
    const dir = ["skills", "skill"].find((d) => existsSync(join(plugin.dir, d, skillRel))) ?? "skills"
    degenerate(join(rel, dir, skillRel), name, `${plugin.name}--${skillRel.split("/").join("-")}`, "rename it, or delete it")
  }
  for (const key of plugin.components.mcp ?? []) {
    if (key && !key.startsWith(".")) continue
    degenerate(join(rel, "mcp.json"), key, `ocm--${plugin.name}--${key}`, "rename it, or delete it")
  }
}

// one finding per broken rule; [] means installable. Manifest rules
// short-circuit, component rules are always checked.
export function pluginGateFindings(marketplaceDir, plugin) {
  const findings = []
  const add = (path, code, message) => findings.push({ plugin: plugin.name, path, code, message })
  const rel = relative(marketplaceDir, plugin.dir)
  const manifestPath = join(rel, "plugin.json")
  const file = join(plugin.dir, "plugin.json")
  if (!existsSync(file)) {
    add(manifestPath, "manifest-missing", `${manifestPath} — missing`)
  } else {
    let manifest = null
    let parsed = false
    try {
      manifest = JSON.parse(readFileSync(file, "utf8"))
      parsed = true
    } catch {
      // a read or parse failure becomes the manifest-unreadable finding below
    }
    if (!parsed) {
      add(manifestPath, "manifest-unreadable", `${manifestPath}: not valid JSON — fix it or remove it; ocm requires this file to be readable`)
    } else if (!isRecord(manifest)) {
      add(manifestPath, "manifest-unreadable", `${manifestPath}: must be a JSON object — fix it or remove it; ocm requires this file to be readable`)
    } else {
      const description = manifest.description
      if (typeof description !== "string") {
        add(manifestPath, "description-missing", `${manifestPath}: "description" is required — add one line about the plugin`)
      } else if (!description.trim()) {
        add(manifestPath, "description-empty", `${manifestPath}: "description" is required and must be non-empty — add one line about the plugin and re-run ocm add`)
      } else if (description.length > 200) {
        add(manifestPath, "description-long", `${manifestPath}: "description" is longer than 200 characters (${description.length}) — shorten it`)
      }
      if (typeof manifest.name === "string" && manifest.name !== plugin.name) {
        add(manifestPath, "name-mismatch", `${manifestPath}: name "${manifest.name}" disagrees with the directory name "${plugin.name}" — rename the directory or fix plugin.json`)
      }
    }
  }
  componentFindings(marketplaceDir, plugin, findings)
  return findings
}

// one finding per broken rule across all plugins, concatenated in input
// plugin order; [] means installable
export function marketplaceGateFindings(marketplaceDir, plugins) {
  return plugins.flatMap((plugin) => pluginGateFindings(marketplaceDir, plugin))
}
