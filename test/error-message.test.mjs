// Filesystem failure classification: a node system error renders as an ocm
// error naming the path and the remedy — the pure renderer, and the CLI path
// that prints it (F83).

import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { assertAbsent, withFakeHome } from "./harness.mjs"

const OCM_BIN = fileURLToPath(new URL("../bin/ocm.ts", import.meta.url))

function ocm(home, ...args) {
  const result = spawnSync(process.execPath, [OCM_BIN, ...args], {
    env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 120_000,
  })
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

const phase = (name, body, timeout = 120_000) => test(name, () => withFakeHome(body), timeout)

function writeTree(dir, tree) {
  mkdirSync(dir, { recursive: true })
  for (const [name, value] of Object.entries(tree)) {
    if (typeof value === "string") writeFileSync(join(dir, name), value)
    else writeTree(join(dir, name), value)
  }
}

function git(dir, args) {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8", timeout: 120_000 })
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${dir}: ${result.stderr}`)
  return result.stdout.trim()
}

function gitRepo(dir, tree) {
  writeTree(dir, tree)
  git(dir, ["init", "-b", "main"])
  git(dir, ["add", "-A"])
  git(dir, ["-c", "user.email=ocm@test", "-c", "user.name=ocm", "commit", "-m", "fixture"])
}

const cfg = (home) => join(home, ".config", "opencode")

const registryFile = (home) => join(cfg(home), "ocm", "registry.json")

const COMMAND = "---\ndescription: demo\n---\n\nDemo body.\n"

const PLUGIN_JSON = `${JSON.stringify({ description: "demo plugin" }, null, 2)}\n`

phase("8. chmod 555 on the cache parent: ocm add fails naming the path and the remedy, with no EACCES: prefix and no registry file left", async (home) => {
  gitRepo(join(home, "remote"), { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND } } } })
  mkdirSync(join(home, ".cache"))
  chmodSync(join(home, ".cache"), 0o555)
  let failed
  try {
    // file:// so the clone's mkdir of the marketplaces dir is the first cache
    // write, before the registry is saved — a plain-path add saves first
    failed = ocm(home, "add", `file://${join(home, "remote")}`, "--name", "mp")
  } finally {
    // restore write permission so withFakeHome's rmSync can remove the home
    chmodSync(join(home, ".cache"), 0o755)
  }
  expect(failed.status).not.toBe(0)
  // invariant: no partial state — the failed add registered nothing
  assertAbsent(registryFile(home))
  expect(failed.stderr).toContain("permission denied")
  expect(failed.stderr).toContain("fix the permissions on")
  expect(failed.stderr).toContain(join(home, ".cache"))
  expect(failed.stderr).not.toContain("EACCES")
})

test("9. errorMessage renders each system-error code as an ocm message for both mkdir and open; a plain Error and a non-Error pass through", async () => {
  const { errorMessage } = await import("../loader/error-message.js")
  const sys = (code, syscall, path, message) => Object.assign(new Error(message), { code, syscall, path })
  const t = mkdtempSync(join(tmpdir(), "ocm-errmsg-"))
  try {
    mkdirSync(join(t, "a"))
    writeFileSync(join(t, "f"), "a regular file\n")
    const deep = join(t, "a", "b", "c")
    const underFile = join(t, "f", "c")
    // [case, err, expected]
    const ROWS = [
      ["EACCES, mkdir", sys("EACCES", "mkdir", deep, `EACCES: permission denied, mkdir '${deep}'`),
        `cannot create ${deep} — permission denied\n  fix the permissions on ${join(t, "a")}, then re-run`],
      ["EACCES, open", sys("EACCES", "open", deep, `EACCES: permission denied, open '${deep}'`),
        `cannot write ${deep} — permission denied\n  fix the permissions on ${join(t, "a")}, then re-run`],
      ["ENOTDIR, mkdir", sys("ENOTDIR", "mkdir", underFile, `ENOTDIR: not a directory, mkdir '${underFile}'`),
        `cannot create ${underFile} — ${join(t, "f")} is not a directory\n  move or remove it, then re-run`],
      ["ENOTDIR, open", sys("ENOTDIR", "open", underFile, `ENOTDIR: not a directory, open '${underFile}'`),
        `cannot write ${underFile} — ${join(t, "f")} is not a directory\n  move or remove it, then re-run`],
      ["EROFS, mkdir", sys("EROFS", "mkdir", deep, `EROFS: read-only file system, mkdir '${deep}'`),
        `cannot create ${deep} — the filesystem is read-only`],
      ["EROFS, open", sys("EROFS", "open", deep, `EROFS: read-only file system, open '${deep}'`),
        `cannot write ${deep} — the filesystem is read-only`],
      ["ENOSPC, mkdir", sys("ENOSPC", "mkdir", deep, `ENOSPC: no space left on device, mkdir '${deep}'`),
        `cannot create ${deep} — no space left on the device`],
      ["ENOSPC, open", sys("ENOSPC", "open", deep, `ENOSPC: no space left on device, open '${deep}'`),
        `cannot write ${deep} — no space left on the device`],
      ["an unknown code keeps node's message with the code prefix stripped",
        sys("EXDEV", "rename", deep, "EXDEV: cross-device link not permitted, rename '/a' -> '/b'"),
        `cannot write ${deep} — cross-device link not permitted, rename '/a' -> '/b'`],
      ["a plain Error", new Error("boom"), "boom"],
      ["a non-Error value", "nope", "nope"],
    ]
    for (const [name, err, expected] of ROWS) {
      const out = errorMessage(err)
      if (out !== expected) throw new Error(`${name}: expected\n${expected}\ngot\n${out}`)
      if (/^E[A-Z]+:/.test(out)) throw new Error(`${name}: the rendered message begins with an errno code:\n${out}`)
    }
    expect(errorMessage(42)).toBe("42")
  } finally {
    rmSync(t, { recursive: true, force: true })
  }
}, 120_000)
