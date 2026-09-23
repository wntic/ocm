// brief 32 §3: a node system error renders as an ocm error naming the path
// and the remedy — never a bare errno code
import { statSync } from "node:fs"
import { dirname } from "node:path"

// walk up from dirname(path); the first ancestor that stats is the nearest
// existing one — null when nothing does, not even the filesystem root
function nearestExistingAncestor(path) {
  let dir = dirname(path)
  for (;;) {
    try {
      return { path: dir, file: statSync(dir).isFile() }
    } catch {}
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

// the verb names what the failed call was doing — the top-level catch sees
// reads as well as writes, and "cannot write" over a missing file sends the
// user to fix permissions that are fine
const READS = new Set(["read", "readdir", "scandir", "readlink", "stat", "lstat", "access", "realpath", "opendir"])

function verbFor(err) {
  if (err.syscall === "mkdir") return "create"
  if (READS.has(err.syscall)) return "read"
  // open is both; ocm creates a file's parent before writing it, so a
  // missing path on open is a read
  if (err.syscall === "open" && err.code === "ENOENT") return "read"
  return "write"
}

export function errorMessage(err) {
  if (!(err instanceof Error)) return String(err)
  const code = err.code
  const path = err.path
  if (typeof code !== "string" || typeof path !== "string") return err.message
  const verb = verbFor(err)
  if (code === "EACCES" || code === "EPERM") {
    const ancestor = nearestExistingAncestor(path)
    return `cannot ${verb} ${path} — permission denied\n  fix the permissions on ${ancestor?.path ?? dirname(path)}, then re-run`
  }
  if (code === "ENOTDIR") {
    const ancestor = nearestExistingAncestor(path)
    if (ancestor?.file) {
      return `cannot ${verb} ${path} — ${ancestor.path} is not a directory\n  move or remove it, then re-run`
    }
  }
  if (code === "EROFS") return `cannot ${verb} ${path} — the filesystem is read-only`
  if (code === "ENOSPC") return `cannot ${verb} ${path} — no space left on the device`
  const prefix = `${code}: `
  // node ends its message with ", <syscall> '<path>'" — the line already
  // names the path
  const detail = (err.message.startsWith(prefix) ? err.message.slice(prefix.length) : err.message)
    .replace(`, ${err.syscall} '${path}'`, "")
  return `cannot ${verb} ${path} — ${detail}`
}
