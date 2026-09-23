// Shared rendering helpers of the display commands (spec 25): list and info
// read the sync age and the trust-pending components the same way, so those
// two live here rather than in either verb.
import { existsSync } from "node:fs"
import { componentRoot, executableComponents, pendingComponents } from "../../loader/core.js"
import type { CoreExecutableComponent } from "../../loader/core.js"
import type { MarketplaceEntry } from "../types"

export function age(iso: string): string {
  const ms = Date.now() - Date.parse(iso)
  if (Number.isNaN(ms) || ms < 60_000) return "just now"
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

// the components a trust prompt would be about, read from the marketplace
// tree; null when the tree cannot be read, so info still answers from the
// registry alone (spec 09)
export function driftedComponents(entry: MarketplaceEntry): CoreExecutableComponent[] | null {
  try {
    return pendingComponents(entry, executableComponents(componentRoot(entry), entry))
  } catch {
    return null
  }
}

// spec 25 §2: the displays render the loader-recorded pending state
export function pendingExecutables(entry: MarketplaceEntry): CoreExecutableComponent[] {
  return entry.trustPending ? driftedComponents(entry) ?? [] : []
}

// brief 36 §5: "none" is the absence of a question when the tree positively
// ships nothing executable — false whenever the tree cannot be read, so the
// trust line never claims anything about a directory it could not open
export function shipsNoExecutables(entry: MarketplaceEntry): boolean {
  try {
    const root = componentRoot(entry)
    return existsSync(root) && executableComponents(root, entry).length === 0
  } catch {
    return false
  }
}

// the executables a marketplace ships, read from the tree: the outcome
// derivation leaves never-linked executables out of the record, so the
// blocked markers render from the same list the trust prompt offers
export function shippedExecutables(entry: MarketplaceEntry): Map<string, { plugin: string[]; mcp: string[] }> {
  const shipped = new Map<string, { plugin: string[]; mcp: string[] }>()
  try {
    for (const component of executableComponents(componentRoot(entry), entry)) {
      let list = shipped.get(component.plugin)
      if (!list) shipped.set(component.plugin, (list = { plugin: [], mcp: [] }))
      list[component.kind].push(component.name)
    }
  } catch {}
  return shipped
}

// the names the displays print: commands and agents drop their .md — the
// user types /parse, not /parse.md (brief 36 §2)
export function bareComponents(components: Partial<Record<string, string[]>>): Partial<Record<string, string[]>> {
  const out: Partial<Record<string, string[]>> = {}
  for (const type of ["command", "agent"] as const) {
    if (components[type]?.length) out[type] = components[type]!.map((file) => file.replace(/\.md$/, ""))
  }
  for (const type of ["skill", "plugin", "mcp"] as const) {
    if (components[type]?.length) out[type] = [...components[type]!]
  }
  return out
}

const LABELS: Record<string, string> = { command: "commands", agent: "agents", skill: "skills", plugin: "plugins", mcp: "mcp" }

export function componentLine(type: string, names: string[]): string {
  return `${LABELS[type]}: ${names.join(", ")}`
}

export function componentSummary(components: Partial<Record<string, string[]>>): string {
  return Object.entries(bareComponents(components))
    .map(([type, names]) => componentLine(type, names!))
    .join(" · ")
}

// brief 36 §1: the width budget every display line wraps to, read per
// invocation so a resize between commands is honoured. OCM_COLUMNS forces
// both the width and the TTY shape — a spawned test child cannot be given
// a real terminal.
export function columns(): number {
  const forced = Number(process.env.OCM_COLUMNS)
  if (forced > 0) return Math.max(forced, 40)
  return Math.max(process.stdout.columns ?? 80, 40)
}

// brief 36 §1 rule 2: wrapping applies only to a TTY — piped output keeps
// one logical line per record so grep still works
export function wrapping(): boolean {
  return Number(process.env.OCM_COLUMNS) > 0 || process.stdout.isTTY === true
}

// brief 36 §1: greedy fill at columns(); continuation lines hang two deeper
// than the first (rule 3). A segment longer than the budget still goes on
// its own line, whole (rule 4) — a line with no content yet is never broken.
export function wrapLine(indent: number, segments: string[], separator = " "): string[] {
  if (!wrapping()) return [`${" ".repeat(indent)}${segments.join(separator)}`]
  const width = columns()
  const lines: string[] = []
  let current = ""
  for (const segment of segments) {
    const candidate = current ? `${current}${separator}${segment}` : `${" ".repeat(indent)}${segment}`
    if (current && candidate.length > width) {
      lines.push(current)
      current = `${" ".repeat(indent + 2)}${segment}`
    } else {
      current = candidate
    }
  }
  if (current) lines.push(current)
  return lines
}
