import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"

export function isGitRepo(dir) {
  return existsSync(join(dir, ".git"))
}

// spec 17: git never prompts — a private repo over https in a tty would hang
// at git's username prompt forever; a user's own GIT_SSH_COMMAND wins
function gitEnv() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" }
  if (!env.GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes"
  return env
}

export function git(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: gitEnv() })
    let stdout = ""
    let stderr = ""
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish({ ok: false, stdout: "", stderr: "git timed out" })
    }, 120_000)
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.on("error", (err) => finish({ ok: false, stdout: "", stderr: String(err) }))
    child.on("close", (code) => finish({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() }))
  })
}
