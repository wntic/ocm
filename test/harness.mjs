// Shared test harness (docs/specs/00-contract.md, "Testing harness").
//
// bun resolves os.homedir() once at process start and ignores later
// process.env.HOME writes (verified on bun 1.4.2), so a test process cannot
// re-import src/ under a fake home — its path constants would still name the
// real home, and calling the installer in-process would write there. The
// module under test therefore runs in a spawned child that inherits the fake
// $HOME from its environment; the child's homedir() is the fake one.
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const RUNNER = `
const [modulePath, exportName] = process.argv.slice(2)
const mod = await import(modulePath)
await mod[exportName]()
`
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url))
const LOADER_MODULE = fileURLToPath(new URL("../src/loader.ts", import.meta.url))
const PLUGIN_ERROR = /level=ERROR.*failed to load plugin/

let opencodeOnPath

export async function withFakeHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "ocm-home-"))
  writeFileSync(join(home, "ocm-runner.mjs"), RUNNER)
  // ESM marker for the installed .js files, same trick as scripts/oc-probe.sh
  writeFileSync(join(home, "package.json"), '{ "type": "module" }\n')
  const previous = process.env.HOME
  process.env.HOME = home
  try {
    const ocm = {
      installLoader: () => runChild(home, LOADER_MODULE, "installLoader"),
    }
    return await fn(home, ocm)
  } finally {
    process.env.HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
}

function runChild(home, modulePath, exportName) {
  const result = spawnSync(process.execPath, [join(home, "ocm-runner.mjs"), modulePath, exportName], {
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  })
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

// Ask the real opencode binary what it sees in configDir. The canary broken
// plugin proves this probe can still detect errors before a clean result is
// believed (same contract as scripts/oc-probe.sh exit 2). Never call this at
// module scope — the opencode spawns belong inside test bodies.
export function opencodeProbe(configDir, home) {
  if (opencodeOnPath === undefined) {
    opencodeOnPath = spawnSync("opencode", ["--version"], { encoding: "utf8", timeout: 30_000 }).status === 0
  }
  if (!opencodeOnPath) return { available: false }
  const scratch = mkdtempSync(join(tmpdir(), "ocm-probe-"))
  try {
    const canaryHome = join(scratch, "home")
    const canaryConfig = join(scratch, "config")
    mkdirSync(canaryHome)
    mkdirSync(join(canaryConfig, "plugins"), { recursive: true })
    writeFileSync(
      join(canaryConfig, "plugins", "canary.js"),
      'export default { id: "probe-canary", setup: async () => ({}) }\n',
    )
    if (pluginErrorLines(canaryConfig, canaryHome).length === 0) return { available: true, unreliable: true }
    let config, skills
    return {
      available: true,
      pluginErrors: pluginErrorLines(configDir, home),
      // resolved names are lazy getters: each spawns opencode, and a caller
      // that only wants pluginErrors must not pay for spawns it never uses
      get commands() {
        config ??= debugJson(configDir, home, ["debug", "config"]) ?? {}
        return Object.keys(config.command ?? {})
      },
      get agents() {
        config ??= debugJson(configDir, home, ["debug", "config"]) ?? {}
        return Object.keys(config.agent ?? {})
      },
      get skills() {
        if (skills === undefined) {
          const parsed = debugJson(configDir, home, ["debug", "skill"])
          skills = Array.isArray(parsed) ? parsed.map((s) => s?.name).filter(Boolean) : []
        }
        return skills
      },
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

// `opencode debug config` prints the resolved config (command/agent keyed by
// name); `opencode debug skill` prints a JSON array of resolved skills.
function debugJson(configDir, home, args) {
  const run = spawnSync("opencode", args, {
    env: { ...process.env, HOME: home, OPENCODE_CONFIG_DIR: configDir },
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 180_000,
  })
  if (run.status !== 0 || !run.stdout) {
    throw new Error(`opencode ${args.join(" ")} exited ${run.status} against ${configDir}: ${run.stderr}`)
  }
  return JSON.parse(run.stdout)
}

function pluginErrorLines(configDir, home) {
  const run = spawnSync("opencode", ["debug", "skill", "--print-logs", "--log-level", "ERROR"], {
    env: { ...process.env, HOME: home, OPENCODE_CONFIG_DIR: configDir },
    cwd: REPO_ROOT,
    encoding: "utf8",
    // opencode 1.18.20 stalls before plugin loading whenever a plugin file
    // exists — observed 50-115s per run, versus ~3s with no plugins. Do not
    // lower this: a timeout here reads as "probe unreliable" and fails tests
    // that are actually fine.
    timeout: 180_000,
  })
  const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`
  return output.split("\n").filter((line) => PLUGIN_ERROR.test(line))
}

export function assertFileExists(path) {
  if (!existsSync(path)) throw new Error(`expected a file at ${path}`)
}

export function assertAbsent(path) {
  if (existsSync(path)) throw new Error(`expected nothing at ${path}`)
}
