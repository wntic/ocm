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

export function errorMessage(err) {
  if (!(err instanceof Error)) return String(err)
  const code = err.code
  const path = err.path
  if (typeof code !== "string" || typeof path !== "string") return err.message
  const verb = err.syscall === "mkdir" ? "create" : "write"
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
  const detail = err.message.startsWith(prefix) ? err.message.slice(prefix.length) : err.message
  return `cannot ${verb} ${path} — ${detail}`
}
