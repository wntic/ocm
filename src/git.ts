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

export function gitAvailable(): boolean {
  const result = spawnSync("git", ["--version"], { encoding: "utf8" })
  return result.status === 0
}

export function clone(url: string, dir: string): void {
  const result = git(["clone", "--depth", "1", url, dir])
  if (!result.ok) {
    throw new Error(`git clone failed: ${result.stderr || result.stdout}`)
  }
}

export function pull(dir: string): { ok: boolean; changed: boolean; output: string } {
  const before = git(["rev-parse", "HEAD"], dir).stdout
  const fetch = git(["fetch", "--depth", "1", "origin"], dir)
  if (!fetch.ok) {
    return { ok: false, changed: false, output: fetch.stderr || fetch.stdout }
  }
  const reset = git(["reset", "--hard", "@{u}"], dir)
  if (!reset.ok) {
    const fallback = git(["reset", "--hard", "FETCH_HEAD"], dir)
    if (!fallback.ok) {
      return { ok: false, changed: false, output: fallback.stderr || fallback.stdout }
    }
  }
  const after = git(["rev-parse", "HEAD"], dir).stdout
  return { ok: true, changed: before !== after, output: after }
}
