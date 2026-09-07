import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { OCM_LOADER_NAME, OPENCODE_GLOBAL_DIR } from "./paths"

const LOADER_FILES = [OCM_LOADER_NAME, "ocm-core.js"]

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

export function installLoader(): void {
  const source = loaderSourceDir()
  const targetDir = join(OPENCODE_GLOBAL_DIR, "plugins")
  mkdirSync(targetDir, { recursive: true })
  for (const file of LOADER_FILES) {
    copyFileSync(join(source, file), join(targetDir, file))
  }
  console.log(`installed auto-sync loader (${join(targetDir, OCM_LOADER_NAME)})`)
}

export function uninstallLoader(): void {
  for (const file of LOADER_FILES) {
    rmSync(join(OPENCODE_GLOBAL_DIR, "plugins", file), { force: true })
  }
  console.log("removed auto-sync loader")
}
