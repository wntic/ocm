import { denyEntry, denyTrust, executableComponents, grantEntry, grantTrust, trustFingerprint } from "../../loader/core.js"
import type { CoreExecutableComponent } from "../../loader/core.js"
import { componentRoot, materializeLinks } from "../install"
import { loadRegistryForWrite, saveRegistry } from "../registry"
import { reportRestart, reportUpgrade, reportWarnings } from "../report"
import type { MarketplaceEntry } from "../types"

// the block every trust decision prints before asking: what runs, where it
// lives, and what it can do (spec 07)
function printTrustBlock(name: string, dir: string, components: CoreExecutableComponent[]): void {
  console.error(`marketplace "${name}" ships code that opencode will execute:`)
  for (const component of components) {
    if (component.kind === "plugin") {
      console.error(`  plugin  ${component.plugin}/${component.name.replace(/\.[jt]s$/, "")} (${component.rel})`)
    } else {
      const value = component.value as Record<string, unknown> | undefined
      const detail =
        value && typeof value.url === "string"
          ? `remote server: ${value.url}`
          : `local server: ${Array.isArray(value?.command) ? (value.command as string[]).join(" ") : ""}`
      console.error(`  mcp     ${component.plugin}/${component.name} (${detail})`)
    }
  }
  console.error("this code runs with your shell's permissions on every opencode start.")
  console.error(`review it at ${dir}`)
  console.error("trust this marketplace to run code? [y/N/skip]")
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

// the prompt half of a trust decision: renders the block and reads the
// answer. The mutation is the caller's — the core never prompts (spec 10a)
export async function promptTrust(
  name: string,
  dir: string,
  components: CoreExecutableComponent[],
): Promise<"granted" | "denied" | "skipped"> {
  printTrustBlock(name, dir, components)
  if (!process.stdin.isTTY) return "skipped"
  const answer = await readAnswer()
  if (answer === "y" || answer === "yes") return "granted"
  if (answer === "skip") return "skipped"
  return "denied"
}

// the update-time decision, applied in memory: the update engine saves the
// registry after reconcile, so a mid-update core call would be overwritten
// by that later save
async function decideTrust(name: string, entry: MarketplaceEntry, root: string, flag?: boolean): Promise<boolean> {
  const components = executableComponents(root, entry)
  if (!components.length) return false
  if (flag === true) {
    grantEntry(entry, components)
    return true
  }
  if (flag === false) {
    denyEntry(entry)
    return false
  }
  const decision = await promptTrust(name, entry.dir, components)
  if (decision === "granted") {
    grantEntry(entry, components)
    return true
  }
  if (decision === "denied") denyEntry(entry)
  return false
}

function reportChanged(name: string, entry: MarketplaceEntry, components: CoreExecutableComponent[]): void {
  const recorded = entry.trust.components ?? {}
  const current = new Map(components.map((c) => [c.rel, c.hash]))
  const added = components.filter((c) => !(c.rel in recorded)).map((c) => c.rel)
  const removed = Object.keys(recorded).filter((rel) => !current.has(rel))
  const modified = components.filter((c) => c.rel in recorded && recorded[c.rel] !== c.hash).map((c) => c.rel)
  console.error(`marketplace "${name}" shipped code that changed since you trusted it:`)
  for (const rel of added) console.error(`  added: ${rel}`)
  for (const rel of removed) console.error(`  removed: ${rel}`)
  for (const rel of modified) console.error(`  modified: ${rel}`)
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

export async function trust(name: string): Promise<void> {
  const { registry, wasV1 } = loadRegistryForWrite()
  const entry = registry.marketplaces[name]
  if (!entry) throw new Error(`marketplace "${name}" not found (ocm list)`)
  const root = componentRoot(entry)
  const components = executableComponents(root, entry)
  if (!components.length) {
    console.log(`marketplace "${name}" ships no code; nothing to trust`)
    return
  }
  const decision = await promptTrust(name, entry.dir, components)
  if (decision === "granted") {
    const result = grantTrust(name)
    if (result.report) {
      reportWarnings(result.report.warnings)
      reportRestart(result.report.created)
    }
    console.log(`marketplace "${name}" trusted to run code`)
    reportUpgrade(result.wasV1)
    return
  }
  if (decision === "denied") {
    const result = denyTrust(name)
    reportWarnings(result.report.warnings)
    reportRestart(result.report.created)
    reportUpgrade(result.wasV1)
    return
  }
  // skipped: the registry is still saved (a v1 migration) and materialized
  saveRegistry(registry)
  const links = materializeLinks(name, entry)
  reportWarnings(links.warnings)
  reportRestart(links.created)
  reportUpgrade(wasV1)
}

export async function untrust(name: string): Promise<void> {
  const result = denyTrust(name)
  reportWarnings(result.report.warnings)
  reportRestart(result.report.removed)
  console.log(`marketplace "${name}" no longer trusted; executable components removed`)
  reportUpgrade(result.wasV1)
}
