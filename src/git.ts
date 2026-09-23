import { spawnSync } from "node:child_process"
import { classifyGitFailure, gitProbe } from "../loader/core.js"

export function git(args: string[], cwd?: string): { ok: boolean; stdout: string; stderr: string; error?: Error } {
  // spec 17: git never prompts — a private repo in a tty would hang at git's
  // username prompt forever; a user's own GIT_SSH_COMMAND wins
  const env: Record<string, string | undefined> = { ...process.env, GIT_TERMINAL_PROMPT: "0" }
  if (!env.GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes"
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    env,
  })
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? "").trim(),
    // brief 32 §1: a spawn error must reach the classifier — git off PATH
    // otherwise fails with an empty stderr
    stderr: result.error ? String(result.error) : (result.stderr ?? "").trim(),
    error: result.error,
  }
}

// brief 32 §1: a command about to clone or fetch stops here, once, when
// git is off PATH — instead of one classified failure per marketplace
export function requireGit(): void {
  const missing = gitProbe()
  if (missing) throw new Error(missing)
}

export function clone(url: string, dir: string, ref?: string | null): void {
  // brief 32 §1: a file:// url's local facts are checked before spawning —
  // a non-repo directory is refused with the plain-path form
  if (url.startsWith("file://")) {
    const pre = classifyGitFailure({ operation: "clone", result: { ok: false, stdout: "", stderr: "" }, url, ref: ref ?? null, dir })
    if (pre.code === "local-missing" || pre.code === "local-not-a-repo") throw new Error(pre.message)
  }
  const args = ["clone", "--depth", "1"]
  if (ref) args.push("--branch", ref)
  args.push(url, dir)
  const result = git(args)
  if (!result.ok) {
    throw new Error(classifyGitFailure({ operation: "clone", result, url, ref: ref ?? null, dir }).message)
  }
}
