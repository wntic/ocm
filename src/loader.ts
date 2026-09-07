import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { OCM_LOADER_NAME, OPENCODE_GLOBAL_DIR } from "./paths"

const LOADER_FILES = [OCM_LOADER_NAME, "ocm-core.js", "ocm-ui.js"]
const TUI_CONFIG_FILE = join(OPENCODE_GLOBAL_DIR, "tui.json")
const TUI_PLUGIN_ENTRY = "./plugins/ocm-ui.js"

function loaderSourceDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, "..", "..", "loader"),
    join(here, "..", "loader"),
    join(here, "loader"),
    here,
  ]
  for (const candidate of candidates) {
    if (LOADER_FILES.every((file) => existsSync(join(candidate, file)))) return candidate
  }
  throw new Error(`loader files not found (${LOADER_FILES.join(", ")})`)
}

function readTuiConfig(): Record<string, unknown> | undefined {
  if (!existsSync(TUI_CONFIG_FILE)) return {}
  try {
    const parsed = JSON.parse(readFileSync(TUI_CONFIG_FILE, "utf8"))
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed
  } catch {
    return undefined
  }
  return {}
}

function writeTuiConfig(config: Record<string, unknown>): void {
  writeFileSync(TUI_CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`)
}

function ensureTuiPluginEntry(): void {
  const config = readTuiConfig()
  if (!config) {
    console.error(`warning: ${TUI_CONFIG_FILE} is not valid JSON, left untouched`)
    console.error(`warning: add "${TUI_PLUGIN_ENTRY}" to its "plugin" array manually for the /ocm TUI command`)
    return
  }
  const plugin = config.plugin
  const entries = Array.isArray(plugin) ? plugin : []
  if (entries.includes(TUI_PLUGIN_ENTRY)) return
  config.plugin = [...entries, TUI_PLUGIN_ENTRY]
  writeTuiConfig(config)
}

function removeTuiPluginEntry(): void {
  const config = readTuiConfig()
  if (!config) return
  const plugin = config.plugin
  if (!Array.isArray(plugin)) return
  const filtered = plugin.filter((entry) => entry !== TUI_PLUGIN_ENTRY)
  if (filtered.length === plugin.length) return
  config.plugin = filtered
  writeTuiConfig(config)
}

export function installLoader(): void {
  const source = loaderSourceDir()
  const targetDir = join(OPENCODE_GLOBAL_DIR, "plugins")
  mkdirSync(targetDir, { recursive: true })
  for (const file of LOADER_FILES) {
    copyFileSync(join(source, file), join(targetDir, file))
  }
  ensureTuiPluginEntry()
  console.log(`installed auto-sync loader (${join(targetDir, OCM_LOADER_NAME)})`)
  console.log(`installed TUI plugin (/ocm in the opencode TUI, restart opencode to activate)`)
}

export function uninstallLoader(): void {
  for (const file of LOADER_FILES) {
    rmSync(join(OPENCODE_GLOBAL_DIR, "plugins", file), { force: true })
  }
  removeTuiPluginEntry()
  console.log("removed auto-sync loader")
}
