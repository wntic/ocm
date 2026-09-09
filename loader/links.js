import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, relative } from "node:path"
import { containsSkillMd } from "./discovery.js"

const RENDERED_MARKER = "ocm: rendered from "

// raw-string prefix compare only: a raw target must never be compared against
// a realpath'd directory (macOS puts temp dirs behind /var -> /private/var)
function insideDir(target, dir) {
  return target === dir || target.startsWith(dir + "/")
}

function targetsInside(target, dirs) {
  return dirs.some((dir) => insideDir(target, dir))
}

function owningPlugin(target) {
  const match = target.match(/\/plugins\/([^/]+)\//)
  return match ? match[1] : null
}

// --force takes over an unowned path by moving it under the displaced dir,
// never deleting: a mistake stays recoverable and the path is reported
function takeOver(dest, ctx) {
  if (!ctx.force) {
    ctx.warnings.push(`skipped ${dest}: not managed by ocm`)
    return false
  }
  const target = join(ctx.displacedDir, dest)
  try {
    mkdirSync(dirname(target), { recursive: true })
    renameSync(dest, target)
  } catch (err) {
    ctx.warnings.push(`failed to displace ${dest}: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
  ctx.warnings.push(`displaced ${dest} -> ${target}`)
  return true
}

export function isRenderedFile(path) {
  try {
    return readFileSync(path, "utf8").includes(RENDERED_MARKER)
  } catch {
    return false
  }
}

// link: dest is owned iff it is a symlink whose target resolves inside a
// managed marketplace directory
export function link(source, dest, ctx, plugin, component) {
  let existing
  try {
    existing = readlinkSync(dest)
  } catch {}
  if (existing === source) return "ok"
  let stat
  try {
    stat = lstatSync(dest)
  } catch {}
  if (stat && !stat.isSymbolicLink()) {
    if (!takeOver(dest, ctx)) return "skipped"
  }
  if (existing !== undefined && existsSync(dest)) {
    if (!targetsInside(existing, ctx.managed)) {
      if (!takeOver(dest, ctx)) return "skipped"
    } else {
      const owner = owningPlugin(existing) ?? ctx.name
      if (owner !== plugin || !insideDir(existing, ctx.dir)) {
        ctx.warnings.push(`${plugin}:${component} conflicts with ${owner}:${component}`)
        return "refused"
      }
    }
  }
  if (stat) {
    try {
      rmSync(dest, { force: true, recursive: true })
    } catch {}
  }
  try {
    symlinkSync(source, dest)
    return "created"
  } catch (err) {
    ctx.warnings.push(`failed ${dest}: ${err instanceof Error ? err.message : String(err)}`)
    return "skipped"
  }
}

// render: dest is owned iff it carries the rendered marker
function render(source, dest, transform, ctx) {
  let output
  try {
    const body = transform(readFileSync(source, "utf8"))
    if (body === null || body === undefined) return "skipped"
    output = body.endsWith("\n") ? body : `${body}\n`
    output += `<!-- ${RENDERED_MARKER}${relative(ctx.dir, source)} @ ${ctx.revision} -->\n`
  } catch (err) {
    ctx.warnings.push(`failed ${source}: ${err instanceof Error ? err.message : String(err)}`)
    return "skipped"
  }
  let stat
  try {
    stat = lstatSync(dest)
  } catch {}
  if (stat) {
    if (stat.isSymbolicLink()) {
      if (existsSync(dest)) {
        if (!takeOver(dest, ctx)) return "skipped"
      }
      try {
        rmSync(dest, { force: true })
      } catch {}
    } else if (!stat.isFile()) {
      if (!takeOver(dest, ctx)) return "skipped"
    } else {
      let current
      try {
        current = readFileSync(dest, "utf8")
      } catch {}
      if (current === output) return "ok"
      if (current === undefined || !current.includes(RENDERED_MARKER)) {
        if (!takeOver(dest, ctx)) return "skipped"
      }
    }
  }
  try {
    writeFileSync(dest, output)
    return "created"
  } catch (err) {
    ctx.warnings.push(`failed ${dest}: ${err instanceof Error ? err.message : String(err)}`)
    return "skipped"
  }
}

// remove owned entries not in the desired set; a symlink is ours iff it
// points into the current marketplace, anything else iff `extra` proves it.
// `scope` restricts the pass to one plugin's entries (plugin-scoped update).
export function gcTargets(dir, desired, ctx, extra, scope) {
  let removed = 0
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return 0
  }
  for (const entry of entries) {
    if (desired.has(entry)) continue
    if (scope !== undefined && !entry.startsWith(scope)) continue
    const path = join(dir, entry)
    let target
    try {
      target = readlinkSync(path)
    } catch {}
    const owned = target !== undefined ? insideDir(target, ctx.dir) : extra ? extra(path) : false
    if (!owned) continue
    try {
      rmSync(path, { force: true, recursive: true })
      removed += 1
    } catch {}
  }
  return removed
}

// mirror: a real directory whose entries are link() or render()
export function mirror(sourceDir, destDir, plan, ctx, plugin, component) {
  mkdirSync(destDir, { recursive: true })
  let entries
  try {
    entries = readdirSync(sourceDir)
  } catch {
    entries = []
  }
  const desired = new Set()
  for (const entry of entries) {
    if (containsSkillMd(join(sourceDir, entry))) continue
    desired.add(entry)
    const transform = plan[entry]
    if (transform) render(join(sourceDir, entry), join(destDir, entry), transform, ctx)
    else link(join(sourceDir, entry), join(destDir, entry), ctx, plugin, component)
  }
  return gcTargets(destDir, desired, ctx, isRenderedFile)
}
