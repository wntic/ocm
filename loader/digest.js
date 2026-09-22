import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { join } from "node:path"

function sha256(data) {
  return createHash("sha256").update(data).digest("hex")
}

// direct stderr is the loader precedent (lock.js): an unreadable component
// is reported, never fatal to the pass recording the digest
function warnUnreadable(path) {
  process.stderr.write(`warning: cannot read ${path} — left out of the change digest\n`)
}

// `commands`/`command` (likewise agents, plugin/plugins) are both legal
// source dirs; dirClashes refuses a name in both, so at most one reads
function fileEntry(plugin, dirs, name) {
  for (const dir of dirs) {
    try {
      return { key: `${dir}/${name}`, hash: sha256(readFileSync(join(plugin.dir, dir, name))) }
    } catch {}
  }
  warnUnreadable(join(plugin.dir, dirs[0], name))
  return null
}

// realpath/seen bounds symlink loops; a directory that cannot be listed is
// skipped silently, matching listSkillDirs
function collectFiles(dir, rel, files, seen) {
  let real
  try {
    real = realpathSync(dir)
  } catch {
    return
  }
  if (seen.has(real)) return
  seen.add(real)
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    const child = join(dir, entry)
    const childRel = `${rel}/${entry}`
    let isDir = false
    try {
      isDir = statSync(child).isDirectory()
    } catch {}
    if (isDir) collectFiles(child, childRel, files, seen)
    else files.push({ rel: childRel, path: child })
  }
}

// a skill is one entry: a single sha256 over its whole subtree, sorted
// plugin-relative paths and content hashes — the trustFingerprint pattern
function skillEntry(plugin, name) {
  for (const dir of ["skills", "skill"]) {
    const skillDir = join(plugin.dir, dir, name)
    if (!existsSync(skillDir)) continue
    const files = []
    collectFiles(skillDir, `${dir}/${name}`, files, new Set())
    files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
    const hash = createHash("sha256")
    for (const file of files) {
      let content
      try {
        content = readFileSync(file.path)
      } catch {
        warnUnreadable(file.path)
        return null
      }
      hash.update(`${file.rel}\n${sha256(content)}\n`)
    }
    return { key: `${dir}/${name}`, hash: hash.digest("hex") }
  }
  warnUnreadable(join(plugin.dir, "skills", name))
  return null
}

// brief 30 §2: what ocm ships from this plugin, keyed by plugin-relative
// path. plugin.json, READMEs and everything else in the plugin directory
// are deliberately not hashed
export function pluginHashes(plugin) {
  const hashes = {}
  const components = plugin.components ?? {}
  for (const name of components.command ?? []) {
    const entry = fileEntry(plugin, ["commands", "command"], name)
    if (entry) hashes[entry.key] = entry.hash
  }
  for (const name of components.agent ?? []) {
    const entry = fileEntry(plugin, ["agents", "agent"], name)
    if (entry) hashes[entry.key] = entry.hash
  }
  for (const name of components.plugin ?? []) {
    const entry = fileEntry(plugin, ["plugin", "plugins"], name)
    if (entry) hashes[entry.key] = entry.hash
  }
  for (const name of components.skill ?? []) {
    const entry = skillEntry(plugin, name)
    if (entry) hashes[entry.key] = entry.hash
  }
  const mcpFile = join(plugin.dir, "mcp.json")
  try {
    hashes["mcp.json"] = sha256(readFileSync(mcpFile))
  } catch (err) {
    if (err?.code !== "ENOENT") warnUnreadable(mcpFile)
  }
  return hashes
}

// brief 30 §2: the recorded digests diffed against the current ones — the
// one comparison behind both the CLI's local report and the loader's
// startup changed-set, so the two paths cannot disagree about what changed
export function digestChanges(hashes, plugin) {
  const current = pluginHashes(plugin)
  const changes = []
  for (const [path, hash] of Object.entries(current)) {
    if (!(path in hashes)) changes.push({ mark: "+", path })
    else if (hashes[path] !== hash) changes.push({ mark: "~", path })
  }
  for (const path of Object.keys(hashes)) {
    if (!(path in current)) changes.push({ mark: "-", path })
  }
  return changes
}
