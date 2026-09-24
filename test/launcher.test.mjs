// The bin/ocm.ts launcher: the shell/TypeScript polyglot header that checks
// for Bun before any TypeScript runs, so a user without Bun gets ocm's own
// error instead of the shell's "env: bun: No such file or directory".

import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { withFakeHome } from "./harness.mjs"

const OCM_BIN = fileURLToPath(new URL("../bin/ocm.ts", import.meta.url))

const PACKAGE_JSON = fileURLToPath(new URL("../package.json", import.meta.url))

// Run bin/ocm.ts the way npm's bin link does — through sh — with a PATH the
// test controls, so the header's Bun check is what answers. Called inside
// withFakeHome, so the spread process.env carries the fake $HOME.
function shOcm(pathValue, ...args) {
  const result = spawnSync("/bin/sh", [OCM_BIN, ...args], {
    env: { ...process.env, PATH: pathValue }, encoding: "utf8", timeout: 120_000,
  })
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

// bun's directory, found at run time: `command -v bun` when the launching
// shell has it on PATH, otherwise the bun running this suite. Never hardcoded.
function bunDir() {
  const which = spawnSync("/bin/sh", ["-c", "command -v bun"], { encoding: "utf8" })
  const bun = which.status === 0 && which.stdout.trim() ? which.stdout.trim() : process.execPath
  return dirname(bun)
}

const phase = (name, body) => test(name, () => withFakeHome(body), 120_000)

phase("sh bin/ocm.ts --version with no bun on PATH exits 1 with ocm's Bun error on stderr and nothing on stdout", async () => {
  const run = shOcm("/usr/bin:/bin", "--version")
  if (run.status !== 1) throw new Error(`expected exit 1 from sh ${OCM_BIN} --version, got ${run.status}:\n${run.stderr}`)
  expect(run.stderr).toContain("ocm needs Bun")
  expect(run.stderr).toContain("https://bun.com")
  expect(run.stdout).toBe("")
})

phase("sh bin/ocm.ts --version with bun on PATH prints the package.json version", async () => {
  const run = shOcm(`${bunDir()}:/usr/bin:/bin`, "--version")
  if (run.status !== 0) throw new Error(`expected exit 0 from sh ${OCM_BIN} --version, got ${run.status}:\n${run.stderr}`)
  const version = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")).version
  expect(run.stdout.trim()).toBe(version)
})

phase("sh bin/ocm.ts help with bun on PATH passes arguments through and prints the usage text", async () => {
  const run = shOcm(`${bunDir()}:/usr/bin:/bin`, "help")
  if (run.status !== 0) throw new Error(`expected exit 0 from sh ${OCM_BIN} help, got ${run.status}:\n${run.stderr}`)
  expect(run.stdout).toContain("usage:")
})
