import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

// the pid suffix keeps two processes from renaming each other's half-written
// temp into place; the rename is what makes the swap atomic
export function writeJsonAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, content)
    renameSync(tmp, path)
  } finally {
    rmSync(tmp, { force: true })
  }
}
