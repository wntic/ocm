// spec 17: name and length limits, checked before any write so an over-long
// name is an ocm error naming the limit rather than a raw ENAMETOOLONG from
// the filesystem after a half-registered marketplace
import { existsSync } from "node:fs"
import { basename, join } from "node:path"

const NAME_CHARS = 64
const COMPONENT_BYTES = 200

// the first limit this plugin breaks, or null: the plugin name itself, or any
// component file name (command, agent, plugin js, skill, mcp server key)
export function pluginLimitViolation(plugin) {
  if (plugin.name.length > NAME_CHARS) {
    return `plugin "${plugin.name}" exceeds ${NAME_CHARS} chars (${plugin.name.length})`
  }
  for (const type of ["command", "agent", "skill", "plugin", "mcp"]) {
    for (const name of plugin.components[type] ?? []) {
      const bytes = Buffer.byteLength(name)
      if (bytes > COMPONENT_BYTES) {
        return `plugin "${plugin.name}".${type} "${name}" exceeds ${COMPONENT_BYTES} bytes (${bytes})`
      }
    }
  }
  return null
}

// the refusal for a marketplace whose plugins break any limit, or null —
// every violation is listed; one bad component refuses the whole add
export function limitRefusal(plugins) {
  const lines = plugins.map(pluginLimitViolation).filter(Boolean)
  if (!lines.length) return null
  return lines.map((line) => `${line}\n  rename it in the marketplace, then re-run ocm add`).join("\n")
}

// brief 28 §3: two names that differ only in case collide once lowercased
// into a plugin name, and a case-insensitive filesystem cannot hold both
// directories — each folded group is returned as its sorted pair
export function foldedDirPairs(names) {
  const groups = new Map()
  for (const name of names) {
    const key = name.toLowerCase()
    groups.set(key, [...(groups.get(key) ?? []), name])
  }
  return [...groups.values()].filter((group) => group.length > 1).map((group) => group.sort())
}

// brief 28 §4: component names that differ only in case install to one link
// name — a name-level rule, so it fires on Linux too. mcp keys are JSON
// object keys and never touch the filesystem, so they are exempt
const COMPONENT_FOLDS = {
  command: { label: "commands", prefix: "commands/", dest: (plugin, name) => `${plugin}:${name.toLowerCase()}` },
  agent: { label: "agents", prefix: "agents/", dest: (plugin, name) => `${plugin}:${name.toLowerCase()}` },
  skill: { label: "skills", prefix: "skills/", dest: (plugin, name) => `${plugin}--${name.toLowerCase().split("/").join("-")}` },
  plugin: { label: "plugin files", prefix: "plugin/", dest: (plugin, name) => `ocm--${plugin}--${name.toLowerCase()}` },
}

// the folded groups in a plugin's component lists, in list order — discovery
// sorts, so the first name of a group is the one materialize keeps
export function foldedComponentGroups(components) {
  const groups = []
  for (const type of Object.keys(COMPONENT_FOLDS)) {
    const byFold = new Map()
    for (const name of components[type] ?? []) {
      const key = name.toLowerCase()
      byFold.set(key, [...(byFold.get(key) ?? []), name])
    }
    for (const names of byFold.values()) {
      if (names.length > 1) groups.push({ type, names })
    }
  }
  return groups
}

// the refusal for a marketplace whose raw plugin list holds a folded pair,
// or null — the raw discovery list, not the manifest map, which has already
// collapsed the pair
export function caseFoldRefusal(name, plugins) {
  const blocks = []
  const pairs = foldedDirPairs(plugins.map((plugin) => basename(plugin.dir)))
  if (pairs.length) {
    const lines = pairs.map((pair) => `  plugins/${pair[0]} and plugins/${pair[1]} both install as plugin "${pair[0].toLowerCase()}"`)
    blocks.push(
      `marketplace "${name}" ships two plugin directories that differ only in case\n` +
      `${lines.join("\n")}\n` +
      "  ask the author to rename one, then re-run ocm add"
    )
  }
  for (const plugin of plugins) {
    for (const group of foldedComponentGroups(plugin.components)) {
      const { label, prefix, dest } = COMPONENT_FOLDS[group.type]
      const names = group.names.map((n) => prefix + n).join(" and ")
      blocks.push(
        `plugin "${plugin.name}" ships two ${label} that differ only in case\n` +
        `  ${names} both install as ${dest(plugin.name, group.names[0])}\n` +
        "  rename one in the marketplace, then re-run ocm add"
      )
    }
  }
  return blocks.length ? blocks.join("\n") : null
}

// classify tree paths the way discovery classifies the working tree, so a
// component fold a case-insensitive checkout collapsed is still seen (F66)
function treePlugins(files) {
  const plugins = new Map()
  const paths = new Map()
  for (const file of files) {
    const segs = file.split("/")
    if (segs[0] !== "plugins" || segs.length < 4) continue
    const rest = segs.slice(2)
    let type = null
    if (rest.length === 2 && rest[1].endsWith(".md")) {
      if (rest[0] === "commands" || rest[0] === "command") type = "command"
      else if (rest[0] === "agents" || rest[0] === "agent") type = "agent"
    } else if (rest.length === 2 && (rest[1].endsWith(".js") || rest[1].endsWith(".ts"))) {
      if (rest[0] === "plugin" || rest[0] === "plugins") type = "plugin"
    } else if (rest.length >= 3 && rest[rest.length - 1] === "SKILL.md" && (rest[0] === "skills" || rest[0] === "skill")) {
      type = "skill"
    }
    if (!type) continue
    const name = type === "skill" ? rest.slice(1, -1).join("/") : rest[1]
    const key = `${segs[1]}/${type}/${name}`
    if (paths.has(key)) continue
    paths.set(key, file)
    const components = plugins.get(segs[1]) ?? {}
    components[type] = [...(components[type] ?? []), name]
    plugins.set(segs[1], components)
  }
  return { plugins, paths }
}

// the same refusals computed from the git tree, which sees pairs a
// case-insensitive checkout has already collapsed (F66)
export function treeFoldRefusal(name, revision, files) {
  const rev7 = revision.slice(0, 7)
  const blocks = []
  const dirNames = [...new Set(files.filter((file) => file.startsWith("plugins/")).map((file) => file.split("/")[1]).filter(Boolean))]
  const pairs = foldedDirPairs(dirNames)
  if (pairs.length) {
    const lines = pairs.map((pair) => `marketplace "${name}" at ${rev7} ships plugins/${pair[0]} and plugins/${pair[1]}`)
    blocks.push(
      `${lines.join("\n")}\n` +
      "  they differ only in case, and this filesystem cannot hold both — the clone would be incomplete\n" +
      "  ask the author to rename one, or add it on a case-sensitive filesystem"
    )
  }
  const { plugins, paths } = treePlugins(files)
  for (const [dir, components] of plugins) {
    for (const group of foldedComponentGroups(components)) {
      const { dest } = COMPONENT_FOLDS[group.type]
      const groupPaths = group.names.map((n) => paths.get(`${dir}/${group.type}/${n}`))
      blocks.push(
        `marketplace "${name}" at ${rev7} ships ${groupPaths.join(" and ")}\n` +
        `  they differ only in case and both install as ${dest(dir.toLowerCase(), group.names[0])} — the clone would be incomplete\n` +
        "  ask the author to rename one, or add it on a case-sensitive filesystem"
      )
    }
  }
  return blocks.length ? blocks.join("\n") : null
}

// spec 19: a plugin without plugin.json is not a plugin — add refuses the
// marketplace whole before any write, listing every missing manifest
export function manifestRefusal(name, plugins) {
  const missing = plugins.filter((plugin) => !existsSync(join(plugin.dir, "plugin.json")))
  if (!missing.length) return null
  const lines = missing.slice(0, 10).map((plugin) => `  plugins/${plugin.name}/plugin.json — missing`)
  if (missing.length > 10) lines.push(`  … and ${missing.length - 10} more`)
  return (
    `marketplace "${name}" is not installable — ${missing.length} ${missing.length === 1 ? "plugin has" : "plugins have"} no plugin.json\n` +
    `${lines.join("\n")}\n` +
    '  each needs at least { "description": "…" }; see ocm validate and the README'
  )
}
