import { existsSync, mkdirSync, copyFileSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { OCM_LOADER_TARGET, OPENCODE_GLOBAL_DIR } from "./paths"

function loaderSource(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, "..", "..", "loader", "ocm-loader.js"),
    join(here, "..", "loader", "ocm-loader.js"),
    join(here, "ocm-loader.js"),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error("ocm-loader.js not found")
}

export function installLoader(): void {
  const source = loaderSource()
  mkdirSync(join(OPENCODE_GLOBAL_DIR, "plugins"), { recursive: true })
  copyFileSync(source, OCM_LOADER_TARGET)
  console.log(`installed auto-sync loader (${OCM_LOADER_TARGET})`)
}

export function uninstallLoader(): void {
  rmSync(OCM_LOADER_TARGET, { force: true })
  console.log("removed auto-sync loader")
}
