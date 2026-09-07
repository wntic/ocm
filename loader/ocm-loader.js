import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { spawn } from "node:child_process"

const REGISTRY_FILE = join(homedir(), ".config", "opencode", "plugins", "ocm-registry.json")
const CACHE_DIR = join(homedir(), ".cache", "ocm")
const STAMP_FILE = join(CACHE_DIR, "last-sync.json")

const MIN_INTERVAL_MS = 60 * 60 * 1000

function readStamp() {
  try {
    return JSON.parse(readFileSync(STAMP_FILE, "utf8"))
  } catch {
    return { lastSync: 0 }
  }
}

function writeStamp() {
  try {
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(STAMP_FILE, `${JSON.stringify({ lastSync: Date.now() })}\n`)
  } catch {}
}

function isGitRepo(dir) {
  try {
    return existsSync(join(dir, ".git"))
  } catch {
    return false
  }
}

function gitPull(dir) {
  return new Promise((resolve) => {
    const child = spawn("git", ["pull", "--ff-only"], { cwd: dir, stdio: "ignore" })
    child.on("close", () => resolve())
    child.on("error", () => resolve())
  })
}

async function syncAll() {
  let registry
  try {
    registry = JSON.parse(readFileSync(REGISTRY_FILE, "utf8"))
  } catch {
    return
  }
  const dirs = Object.values(registry.marketplaces ?? {})
    .map((entry) => entry.dir)
    .filter((dir) => typeof dir === "string" && dir.startsWith(join(homedir(), ".cache", "ocm")))
    .filter((dir) => isGitRepo(dir))
  await Promise.all(dirs.map((dir) => gitPull(dir)))
  writeStamp()
}

export const OcmLoader = async () => {
  const { lastSync } = readStamp()
  if (Date.now() - lastSync > MIN_INTERVAL_MS) {
    void syncAll()
  }
  return {}
}
