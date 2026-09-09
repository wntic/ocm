import { spawnSync } from "node:child_process"

export function git(args: string[], cwd?: string): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
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
    throw new Error(`git clone failed: ${result.stderr || result.stdout}`)
  }
}
