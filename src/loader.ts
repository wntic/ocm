import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { OCM_DIR, OCM_LEGACY_REGISTRY_FILE, OCM_LOADER_NAME, OPENCODE_GLOBAL_DIR, OPENCODE_PLUGINS_DIR } from "./paths"

const TUI_CONFIG_FILE = join(OPENCODE_GLOBAL_DIR, "tui.json")
const TUI_PLUGIN_ENTRY = "./ocm/ui.js"
const LEGACY_TUI_PLUGIN_ENTRY = "./plugins/ocm-ui.js"
const LEGACY_PLUGIN_FILES = ["ocm-core.js", "ocm-ui.js", "ocm-core.d.ts"]

// only a subset proves a candidate is the loader source dir; the full install
// list is derived from the directory itself (spec 01, Installation set)
const REQUIRED_LOADER_FILES = [OCM_LOADER_NAME, "core.js", "ui.js"]

function loaderSourceDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, "..", "..", "loader"),
    join(here, "..", "loader"),
    join(here, "loader"),
    here,
  ]
  for (const candidate of candidates) {
    if (REQUIRED_LOADER_FILES.every((name) => existsSync(join(candidate, name)))) return candidate
  }
  throw new Error(`loader files not found (${REQUIRED_LOADER_FILES.join(", ")})`)
}

// the installed set is the loader directory by definition: ocm-loader.js to
// plugins/, every other *.js / *.d.ts to ocm/; the filter keeps editor junk
// (e.g. .DS_Store) out of the install
function loaderFiles(sourceDir: string): { source: string; target: string }[] {
  return readdirSync(sourceDir)
    .filter((name) => /\.(js|d\.ts)$/.test(name))
    .sort()
    .map((name) => ({
      source: name,
      target: join(name === OCM_LOADER_NAME ? OPENCODE_PLUGINS_DIR : OCM_DIR, name),
    }))
}

function packageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const parsed = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version?: unknown }
  return typeof parsed.version === "string" ? parsed.version : "0"
}

function stamped(source: string): string {
  const content = readFileSync(source, "utf8")
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 8)
  return `${content.trimEnd()}\n// ocm-version: ${packageVersion()} ${hash}\n`
}

function readTuiConfig(): Record<string, unknown> | undefined {
  if (!existsSync(TUI_CONFIG_FILE)) return {}
  try {
    const parsed = JSON.parse(readFileSync(TUI_CONFIG_FILE, "utf8")) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {}
  return undefined
}

function writeTuiConfig(config: Record<string, unknown>): void {
  const tmp = `${TUI_CONFIG_FILE}.ocm-tmp`
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`)
  renameSync(tmp, TUI_CONFIG_FILE)
}

function warnTuiManual(reason: string): void {
  console.error(`warning: ${TUI_CONFIG_FILE} ${reason}, left untouched`)
  console.error(`warning: add "${TUI_PLUGIN_ENTRY}" to its "plugin" array manually for the /ocm TUI command`)
}

function ensureTuiPluginEntry(): void {
  const config = readTuiConfig()
  if (!config) {
    warnTuiManual("is not valid JSON or not a JSON object")
    return
  }
  const plugin = config.plugin
  if (plugin !== undefined && !Array.isArray(plugin)) {
    warnTuiManual('has a "plugin" key that is not an array')
    return
  }
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

function rewriteLegacyTuiPluginEntry(): void {
  const config = readTuiConfig()
  if (!config) {
    warnTuiManual("is not valid JSON or not a JSON object")
    return
  }
  const plugin = config.plugin
  if (!Array.isArray(plugin) || !plugin.includes(LEGACY_TUI_PLUGIN_ENTRY)) return
  config.plugin = plugin.map((entry) => (entry === LEGACY_TUI_PLUGIN_ENTRY ? TUI_PLUGIN_ENTRY : entry))
  writeTuiConfig(config)
}

function installFiles(sourceDir: string): void {
  if (existsSync(OCM_DIR) && !statSync(OCM_DIR).isDirectory()) {
    throw new Error(`${OCM_DIR} exists but is not a directory; remove it or move it aside, then re-run ocm init`)
  }
  mkdirSync(OPENCODE_PLUGINS_DIR, { recursive: true })
  mkdirSync(OCM_DIR, { recursive: true })
  for (const file of loaderFiles(sourceDir)) {
    const content = stamped(join(sourceDir, file.source))
    let current: string | undefined
    try {
      current = readFileSync(file.target, "utf8")
    } catch {
      current = undefined
    }
    if (current === content) continue
    writeFileSync(file.target, content)
  }
  ensureTuiPluginEntry()
}

export function migrateLegacyLayout(): void {
  const triggered = ["ocm-core.js", "ocm-ui.js"].some((name) => existsSync(join(OPENCODE_PLUGINS_DIR, name)))
  if (!triggered) return
  mkdirSync(OCM_DIR, { recursive: true })
  if (existsSync(OCM_LEGACY_REGISTRY_FILE)) {
    renameSync(OCM_LEGACY_REGISTRY_FILE, join(OCM_DIR, "registry.json"))
  }
  for (const name of LEGACY_PLUGIN_FILES) {
    rmSync(join(OPENCODE_PLUGINS_DIR, name), { force: true })
  }
  rewriteLegacyTuiPluginEntry()
  installFiles(loaderSourceDir())
  // spec 01 migration step 5 pins this line to stdout
  console.log(`migrated ocm registry to ${join(OCM_DIR, "registry.json")}`)
}

export function installLoader(): void {
  migrateLegacyLayout()
  installFiles(loaderSourceDir())
  console.error(`installed auto-sync loader (${join(OPENCODE_PLUGINS_DIR, OCM_LOADER_NAME)})`)
  console.error(`installed TUI plugin (/ocm in the opencode TUI, restart opencode to activate)`)
}

export function uninstallLoader(): void {
  for (const name of [OCM_LOADER_NAME, ...LEGACY_PLUGIN_FILES]) {
    rmSync(join(OPENCODE_PLUGINS_DIR, name), { force: true })
  }
  rmSync(OCM_DIR, { recursive: true, force: true })
  removeTuiPluginEntry()
  console.log("removed auto-sync loader")
}
