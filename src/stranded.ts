// brief 28 §2: an install stranded in the other config root. The breadcrumb
// written by loader/registry.js names every root a registry write went to;
// the cache does not move, so the check is symmetric in both directions.
// ocm reports and never migrates — the user picks the root.
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { OCM_CACHE_DIR, OCM_REGISTRY_FILE, OPENCODE_GLOBAL_DIR } from "./paths"

export interface StrandedRoot {
  root: string
  marketplaces: number
}

function readRecordedRoots(): string[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(OCM_CACHE_DIR, "roots.json"), "utf8"))
    if (typeof raw === "object" && raw !== null && Array.isArray((raw as { roots?: unknown }).roots)) {
      return (raw as { roots: unknown[] }).roots.filter((root): root is string => typeof root === "string")
    }
  } catch {}
  return []
}

// tolerant like readRegistry: a missing or unusable registry means the root
// holds nothing worth reporting
function countMarketplaces(root: string): number {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(root, "ocm", "registry.json"), "utf8"))
    if (typeof raw === "object" && raw !== null && typeof (raw as { marketplaces?: unknown }).marketplaces === "object") {
      return Object.keys((raw as { marketplaces: object }).marketplaces).length
    }
  } catch {}
  return 0
}

// Every root ocm has written since the breadcrumb existed, plus the default
// one. The default matters for the case the breadcrumb cannot cover: an
// install made before this version left no crumb, so a user who already had
// XDG_CONFIG_HOME set sees their whole install vanish on upgrade — the exact
// harm this check exists to report. The reverse direction (XDG unset, install
// under some XDG root) is unknowable without a crumb and stays breadcrumb-only.
function candidateRoots(): string[] {
  const roots = readRecordedRoots()
  if (process.env.XDG_CONFIG_HOME) roots.push(join(homedir(), ".config", "opencode"))
  return [...new Set(roots)]
}

export function strandedRoots(): StrandedRoot[] {
  const active = resolve(OPENCODE_GLOBAL_DIR)
  const stranded: StrandedRoot[] = []
  for (const recorded of candidateRoots()) {
    const root = resolve(recorded)
    if (root === active) continue
    const marketplaces = countMarketplaces(root)
    if (marketplaces > 0) stranded.push({ root, marketplaces })
  }
  return stranded
}

// the two state lines shared by the doctor finding and the mutation notice
function stateLines(stranded: StrandedRoot): string {
  const n = stranded.marketplaces
  return (
    `  installed at: ${stranded.root} (${n} marketplace${n === 1 ? "" : "s"})\n` +
    `  this shell:   ${resolve(OPENCODE_GLOBAL_DIR)} (${process.env.XDG_CONFIG_HOME ? "XDG_CONFIG_HOME is set" : "XDG_CONFIG_HOME is not set"})`
  )
}

// the remedy is direction-aware: with the variable set, unsetting it reaches
// the stranded install; with it unset, setting it to the stranded config home
// does — the recorded root is the opencode dir, so dirname yields the home
export function strandedMessage(stranded: StrandedRoot): string {
  const remedy = process.env.XDG_CONFIG_HOME
    ? "unset XDG_CONFIG_HOME to use the existing install, or re-add those marketplaces here"
    : `set XDG_CONFIG_HOME to ${dirname(stranded.root)} to use the existing install, or re-add those marketplaces here`
  return (
    "an ocm install is stranded in another config root\n" +
    `${stateLines(stranded)}\n` +
    "  opencode reads the second; nothing in the first is visible to it\n" +
    `  ${remedy}`
  )
}

// brief 28 §2.3: the mutating commands warn once before proceeding — the
// mutation is never refused. Only when the active root holds no registry:
// two live installs are a user decision, not a stranding. Returns whether
// the notice printed, so read-only commands can drop hints it contradicts.
export function reportStrandedNotice(): boolean {
  if (existsSync(OCM_REGISTRY_FILE)) return false
  const first = strandedRoots()[0]
  if (!first) return false
  console.error(`warning: an ocm install is stranded in another config root\n${stateLines(first)}`)
  return true
}

// brief 28 §1 edge case: a relative XDG_CONFIG_HOME makes the install move
// with the cwd — warn rather than silently resolving it, because an install
// that moves is not an install. Brief 38 §3: the warning lives at the write
// boundary, not only in doctor
export function relativeXdgWarning(): string | null {
  const xdg = process.env.XDG_CONFIG_HOME
  if (!xdg || xdg.startsWith("/")) return null
  return "XDG_CONFIG_HOME is relative — every ocm command run from a different directory sees a different install; set it to an absolute path"
}
