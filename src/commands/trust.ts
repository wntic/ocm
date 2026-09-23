import {
  denyComponentsEntry,
  denyEntry,
  denyTrust,
  executableComponents,
  grantEntry,
  grantTrust,
  pendingComponents,
  skipEntry,
} from "../../loader/core.js"
import type { CoreExecutableComponent, CoreMaterializeReport } from "../../loader/core.js"
import { componentRoot, materializeLinks } from "../install"
import { loadRegistryForWrite, saveRegistry } from "../registry"
import { reportMutationWarnings, reportRestart, reportUpgrade, reportWarnings } from "../report"
import type { MarketplaceEntry } from "../types"
import { printTrustListing, promptTrust } from "./trust-prompt"

// a decline: first sight denies the whole marketplace (spec 07); a re-prompt
// denies only the components it was about, naming what stops running
function decline(entry: MarketplaceEntry, pending: CoreExecutableComponent[]): void {
  if (entry.trust.code !== "granted") {
    denyEntry(entry)
    return
  }
  const recorded = entry.trust.components ?? {}
  for (const component of pending) {
    const prior = recorded[component.rel]
    if (typeof prior === "string" && !prior.startsWith("!")) {
      console.error(`${component.rel} was running under the previous grant and is now blocked`)
    }
  }
  denyComponentsEntry(entry, pending)
}

// Ctrl+C at an update's re-prompt: the pull already happened, and drifted
// components may still be linked against the on-disk grant — unlinking them
// is the only safe move (spec 07) — then say what stands
function updateInterrupt(name: string, entry: MarketplaceEntry): () => void {
  return () => {
    try {
      const links = materializeLinks(name, entry)
      reportWarnings(links.warnings)
    } catch {}
    console.error(`interrupted — marketplace "${name}" is updated; the trust decision was not recorded`)
    console.error(entry.trust.code === "granted"
      ? "  trust: granted at the previous fingerprint (changed executable components are blocked)"
      : "  trust: undecided (executable components are blocked)")
    console.error(`  run \`ocm trust ${name}\` to decide`)
  }
}

// the update-time decision, applied in memory: the update engine saves the
// registry after reconcile, so a mid-update core call would be overwritten
// by that later save
async function decideTrust(
  name: string,
  entry: MarketplaceEntry,
  root: string,
  flag: boolean | undefined,
  pending: CoreExecutableComponent[],
): Promise<boolean> {
  const components = executableComponents(root, entry)
  if (flag === true) {
    grantEntry(entry, components)
    return true
  }
  if (flag === false) {
    decline(entry, pending)
    return false
  }
  const decision = await promptTrust(name, entry.dir, pending, updateInterrupt(name, entry))
  if (decision === "granted") {
    grantEntry(entry, components)
    return true
  }
  if (decision === "denied") decline(entry, pending)
  else if (entry.trust.code === "none") skipEntry(entry, pending)
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
// one reports the diff and re-prompts (spec 07). With nothing new to decide,
// one reminder line replaces the full block (spec 16)
export async function decideUpdateTrust(
  name: string,
  entry: MarketplaceEntry,
  root: string,
  flag?: boolean,
): Promise<boolean> {
  const components = executableComponents(root, entry)
  if (!components.length || entry.trust.code === "denied") return false
  const pending = pendingComponents(entry, components)
  if (entry.trust.code === "granted" && !pending.length) return false
  if (!pending.length && flag === undefined) return false
  if (entry.trust.code === "granted") reportChanged(name, entry, components)
  return decideTrust(name, entry, root, flag, pending)
}

// the shared tail of a recorded decision: the materialize report and a
// possible v1 upgrade note. spec 23 §7: blocked components collapse to one
// line — this is a re-print of a known-untrusted state, not first sight
function reportDecision(name: string, result: { report: CoreMaterializeReport | null; wasV1: boolean }): void {
  if (result.report) {
    reportMutationWarnings(result.report, { marketplace: name })
    reportRestart(result.report)
  }
  reportUpgrade(result.wasV1)
}

export async function trust(name: string, yes = false): Promise<void> {
  const { registry, wasV1 } = loadRegistryForWrite()
  const entry = registry.marketplaces[name]
  if (!entry) throw new Error(`marketplace "${name}" not found (ocm list)`)
  const root = componentRoot(entry)
  const components = executableComponents(root, entry)
  if (!components.length) {
    console.log(`marketplace "${name}" ships no code; nothing to trust`)
    return
  }
  const recorded = entry.trust.components ?? {}
  if (entry.trust.code === "granted" && components.every((c) => recorded[c.rel] === c.hash)) {
    console.log(`marketplace "${name}" already trusted`)
    return
  }
  let decision: "granted" | "denied" | "skipped"
  if (yes) {
    // a blind grant still shows what it grants (spec 16 §4)
    printTrustListing(name, entry.dir, components)
    decision = "granted"
  } else {
    decision = await promptTrust(name, entry.dir, components, () => {
      console.error(`interrupted — marketplace "${name}" is unchanged; the trust decision was not recorded`)
    })
  }
  if (decision === "granted") {
    const result = grantTrust(name)
    reportDecision(name, result)
    console.log(`marketplace "${name}" trusted to run code`)
    return
  }
  if (decision === "denied") {
    reportDecision(name, denyTrust(name))
    return
  }
  if (!process.stdin.isTTY) throw new Error("stdin is not interactive — re-run with --yes to grant")
  // skipped: the registry is still saved (a v1 migration) and materialized
  saveRegistry(registry)
  reportDecision(name, { report: materializeLinks(name, entry), wasV1 })
}

export async function untrust(name: string): Promise<void> {
  const result = denyTrust(name)
  reportMutationWarnings(result.report, { marketplace: name })
  reportRestart(result.report)
  const removed = result.report.outcomes.some((o) => o.state === "removed")
  if (removed) console.log(`marketplace "${name}" no longer trusted; executable components removed`)
  else if (result.wasGranted) console.log(`marketplace "${name}" no longer trusted; it ships nothing executable, nothing was removed`)
  else console.log(`marketplace "${name}" was not trusted; nothing changed`)
  reportUpgrade(result.wasV1)
}
