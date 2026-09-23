import { spawnSync } from "node:child_process"
import { classifyGitFailure } from "./git-errors.js"

let cached

// brief 32 §1 "check git once, early": one `git --version` per process,
// cached, before a command's first clone or fetch — git off PATH stops the
// command once instead of failing per marketplace. `ocm doctor` keeps its
// own warning (checkGitPath) and does not call this.
export function gitProbe() {
  if (cached === undefined) {
    const run = spawnSync("git", ["--version"], { encoding: "utf8", timeout: 10_000 })
    // the classifier is asked for its git-missing category with the
    // canonical spawn-error shape: bun words a missing binary differently
    // from node, and the runtime's own error text would not recognise
    cached = run.error || run.status !== 0
      ? classifyGitFailure({
          operation: "clone",
          result: { ok: false, stdout: "", stderr: "Error: spawn git ENOENT" },
          url: "git",
          ref: null,
          dir: "git",
        }).message
      : null
  }
  return cached
}
