import { executableComponents, trustFingerprint } from "../../loader/core.js"
import { componentRoot, materializeLinks } from "../install"
import { loadRegistryForWrite, saveRegistry } from "../registry"
import { reportRestart, reportUpgrade, reportWarnings } from "../report"
import type { CoreExecutableComponent } from "../../loader/core.js"
import type { MarketplaceEntry, Registry } from "../types"

export function grant(entry: MarketplaceEntry, components: CoreExecutableComponent[]): void {
  entry.trust = {
    code: "granted",
    grantedAt: new Date().toISOString(),
    fingerprint: trustFingerprint(components),
    components: Object.fromEntries(components.map((c) => [c.rel, c.hash])),
  }
  delete entry.trustPending
}

export function deny(entry: MarketplaceEntry): void {
  entry.trust = { code: "denied" }
  delete entry.trustPending
}

// the block every trust decision prints before asking: what runs, where it
// lives, and what it can do (spec 07)
function printTrustBlock(name: string, entry: MarketplaceEntry, root: string, components: CoreExecutableComponent[]): void {
  console.log(`marketplace "${name}" ships code that opencode will execute:`)
  for (const component of components) {
    if (component.kind === "plugin") {
      console.log(`  plugin  ${component.plugin}/${component.name.replace(/\.[jt]s$/, "")} (${component.rel})`)
    } else {
      const value = component.value as Record<string, unknown> | undefined
      const detail =
        value && typeof value.url === "string"
          ? `remote server: ${value.url}`
          : `local server: ${Array.isArray(value?.command) ? (value.command as string[]).join(" ") : ""}`
      console.log(`  mcp     ${component.plugin}/${component.name} (${detail})`)
    }
  }
  console.log("this code runs with your shell's permissions on every opencode start.")
  console.log(`review it at ${entry.dir}`)
  console.log("trust this marketplace to run code? [y/N/skip]")
}

async function readAnswer(): Promise<string> {
  const { createInterface } = await import("node:readline/promises")
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question("")).trim().toLowerCase()
  } finally {
    rl.close()
  }
}

// the add-time decision: --trust grants, --no-trust denies, a TTY prompts,
// anything else prints the block and leaves trust unset (spec 07)
export async function decideTrust(
  name: string,
  entry: MarketplaceEntry,
  root: string,
  flag?: boolean,
): Promise<boolean> {
  const components = executableComponents(root, entry)
  if (!components.length) return false
  if (flag === true) {
    grant(entry, components)
    return true
  }
  if (flag === false) {
    deny(entry)
    return false
  }
  printTrustBlock(name, entry, root, components)
  if (!process.stdin.isTTY) return false
  const answer = await readAnswer()
  if (answer === "y" || answer === "yes") {
    grant(entry, components)
    return true
  }
  if (answer === "skip") return false
  deny(entry)
  return false
}

function reportChanged(name: string, entry: MarketplaceEntry, components: CoreExecutableComponent[]): void {
  const recorded = entry.trust.components ?? {}
  const current = new Map(components.map((c) => [c.rel, c.hash]))
  const added = components.filter((c) => !(c.rel in recorded)).map((c) => c.rel)
  const removed = Object.keys(recorded).filter((rel) => !current.has(rel))
  const modified = components.filter((c) => c.rel in recorded && recorded[c.rel] !== c.hash).map((c) => c.rel)
  console.log(`marketplace "${name}" shipped code that changed since you trusted it:`)
  for (const rel of added) console.log(`  added: ${rel}`)
  for (const rel of removed) console.log(`  removed: ${rel}`)
  for (const rel of modified) console.log(`  modified: ${rel}`)
}

// the update-time decision: an unchanged or denied grant stands; a drifted
// one reports the diff and re-prompts (spec 07)
export async function decideUpdateTrust(
  name: string,
  entry: MarketplaceEntry,
  root: string,
  flag?: boolean,
): Promise<boolean> {
  const components = executableComponents(root, entry)
  if (!components.length || entry.trust.code === "denied") return false
  if (entry.trust.code === "granted" && entry.trust.fingerprint === trustFingerprint(components)) return false
  if (entry.trust.code === "granted") reportChanged(name, entry, components)
  return decideTrust(name, entry, root, flag)
}

function requireEntry(registry: Registry, name: string): MarketplaceEntry {
  const entry = registry.marketplaces[name]
  if (!entry) throw new Error(`marketplace "${name}" not found (ocm list)`)
  return entry
}

export async function trust(name: string): Promise<void> {
  const { registry, wasV1 } = loadRegistryForWrite()
  const entry = requireEntry(registry, name)
  const root = componentRoot(entry)
  const components = executableComponents(root, entry)
  if (!components.length) {
    console.log(`marketplace "${name}" ships no code; nothing to trust`)
    return
  }
  const granted = await decideTrust(name, entry, root)
  saveRegistry(registry)
  const links = materializeLinks(name, entry)
  reportWarnings(links.warnings)
  reportRestart(links.created)
  if (granted) console.log(`marketplace "${name}" trusted to run code`)
  reportUpgrade(wasV1)
}

export async function untrust(name: string): Promise<void> {
  const { registry, wasV1 } = loadRegistryForWrite()
  const entry = requireEntry(registry, name)
  // idempotent: a second untrust writes nothing (spec 07)
  if (entry.trust.code !== "denied" || entry.trustPending) {
    deny(entry)
    saveRegistry(registry)
  }
  const links = materializeLinks(name, entry)
  reportWarnings(links.warnings)
  reportRestart(links.removed)
  console.log(`marketplace "${name}" no longer trusted; executable components removed`)
  reportUpgrade(wasV1)
}
