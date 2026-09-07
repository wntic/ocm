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

export function clone(url: string, dir: string): void {
  const result = git(["clone", "--depth", "1", url, dir])
  if (!result.ok) {
    throw new Error(`git clone failed: ${result.stderr || result.stdout}`)
  }
}
