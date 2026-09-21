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
import { appendDisplacement, displayPath } from "./displaced.js"

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
// never deleting: a mistake stays recoverable and the path is reported. The
// displacement is recorded so a later teardown can restore it (spec 21).
function takeOver(dest, ctx, plugin) {
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
  appendDisplacement({ marketplace: ctx.name, plugin, dest, dir: ctx.displacedDir })
  ctx.displacements.set(dest, target)
  ctx.warnings.push(`displaced your ${displayPath(dest)} → ${target}`)
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
    if (!takeOver(dest, ctx, plugin)) return "skipped"
  }
  if (existing !== undefined && existsSync(dest)) {
    if (!targetsInside(existing, ctx.managed)) {
      if (!takeOver(dest, ctx, plugin)) return "skipped"
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
function render(source, dest, transform, ctx, plugin) {
  let body
  let output
  try {
    const transformed = transform(readFileSync(source, "utf8"))
    if (transformed === null || transformed === undefined) return "skipped"
    body = transformed.endsWith("\n") ? transformed : `${transformed}\n`
    output = body + `<!-- ${RENDERED_MARKER}${relative(ctx.dir, source)} @ ${ctx.revision} -->\n`
  } catch (err) {
    ctx.warnings.push(`failed ${source}: ${err instanceof Error ? err.message : String(err)}`)
    return "skipped"
  }
  let silent = false
  let stat
  try {
    stat = lstatSync(dest)
  } catch {}
  if (stat) {
    if (stat.isSymbolicLink()) {
      if (existsSync(dest)) {
        if (!takeOver(dest, ctx, plugin)) return "skipped"
      }
      try {
        rmSync(dest, { force: true })
      } catch {}
    } else if (!stat.isFile()) {
      if (!takeOver(dest, ctx, plugin)) return "skipped"
    } else {
      let current
      try {
        current = readFileSync(dest, "utf8")
      } catch {}
      if (current === output) return "ok"
      // brief 31 §2: a trailer-only difference (the revision moved, the
      // body did not) is rewritten silently and still counts as current
      const marker = current === undefined ? -1 : current.lastIndexOf(`<!-- ${RENDERED_MARKER}`)
      if (marker !== -1 && current.slice(0, marker) === body) silent = true
      else if (current === undefined || !current.includes(RENDERED_MARKER)) {
        if (!takeOver(dest, ctx, plugin)) return "skipped"
      }
    }
  }
  try {
    writeFileSync(dest, output)
    return silent ? "ok" : "created"
  } catch (err) {
    ctx.warnings.push(`failed ${dest}: ${err instanceof Error ? err.message : String(err)}`)
    return "skipped"
  }
}

// remove owned entries not in the desired set; a symlink is ours iff it
// points into the current marketplace, anything else iff `extra` proves it.
// `scope` restricts the pass to one plugin's entries (plugin-scoped update).
// Returns the names of the entries it removed.
export function gcTargets(dir, desired, ctx, extra, scope) {
  const removed = []
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return removed
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
      removed.push(entry)
    } catch {}
  }
  return removed
}

// mirror: a real directory whose entries are link() or render(). The
// created count rides along (spec 23 §5): a skill's first materialization
// counts toward the report, so the restart notice follows actual changes.
// `status` is the transform entry's render() result; `removed` names the
// entries the mirror's own gc took down.
export function mirror(sourceDir, destDir, plan, ctx, plugin, component) {
  mkdirSync(destDir, { recursive: true })
  let entries
  try {
    entries = readdirSync(sourceDir)
  } catch {
    entries = []
  }
  const desired = new Set()
  let created = 0
  let status = "ok"
  for (const entry of entries) {
    if (containsSkillMd(join(sourceDir, entry))) continue
    desired.add(entry)
    const transform = plan[entry]
    const result = transform
      ? render(join(sourceDir, entry), join(destDir, entry), transform, ctx, plugin)
      : link(join(sourceDir, entry), join(destDir, entry), ctx, plugin, component)
    if (transform) status = result
    if (result === "created") created += 1
  }
  return { status, created, removed: gcTargets(destDir, desired, ctx, isRenderedFile) }
}
