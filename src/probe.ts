import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OPENCODE_GLOBAL_DIR } from "./paths"

// Ask the real opencode binary which of its plugins failed to load, keeping
// only errors attributable to ocm files. The probe runs against a throwaway
// copy of the config directory under a scratch HOME: opencode rewrites
// opencode.json on load (it adds $schema) and creates files under HOME, so
// probing the real directory would mutate the user's config. OCM_SYNC_DISABLE
// keeps the copied loader's startup sync inert as well. Never throws — a
// failed probe reports nothing, it does not take doctor down with it.
export function ocmPluginErrors(): string[] {
  if (!existsSync(OPENCODE_GLOBAL_DIR)) return []
  let scratch: string | undefined
  try {
    scratch = mkdtempSync(join(tmpdir(), "ocm-doctor-"))
    const configDir = join(scratch, "config")
    cpSync(OPENCODE_GLOBAL_DIR, configDir, { recursive: true })
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: join(scratch, "home"),
      OPENCODE_CONFIG_DIR: configDir,
      OCM_SYNC_DISABLE: "1",
    }
    // an XDG override would point opencode back at the real global config
    delete env.XDG_CONFIG_HOME
    const run = spawnSync("opencode", ["debug", "skill", "--print-logs", "--log-level", "ERROR"], {
      env,
      encoding: "utf8",
      timeout: 180_000,
    })
    if (run.status !== 0) return []
    const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`
    return output
      .split("\n")
      .filter((line) => /level=ERROR.*failed to load plugin/.test(line))
      .filter((line) => line.includes("/ocm--") || line.includes("/ocm-loader.js"))
      .map((line) => line.trim())
  } catch {
    return []
  } finally {
    if (scratch !== undefined) {
      // opencode leaves background writers in the scratch dir; a leftover
      // temp directory is harmless, a crashed doctor is not
      try {
        rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      } catch {}
    }
  }
}
