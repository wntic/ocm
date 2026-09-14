import { spawnSync } from "node:child_process"

export function git(args: string[], cwd?: string): { ok: boolean; stdout: string; stderr: string } {
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
    stderr: (result.stderr ?? "").trim(),
  }
}

export function clone(url: string, dir: string, ref?: string | null): void {
  const args = ["clone", "--depth", "1"]
  if (ref) args.push("--branch", ref)
  args.push(url, dir)
  const result = git(args)
  if (!result.ok) {
    throw new Error(`cannot access ${url} — the repository is private, unreachable, or the URL is wrong`)
  }
}
