import { readFileSync } from "node:fs"
import { join } from "node:path"
import { addMarketplace, denyTrust, duplicateRefusal, grantTrust, isGitUrl, normaliseMarketplaceName, parseSource, pinMarketplace, readRegistry, removeMarketplace, skipTrust } from "../../loader/core.js"
import type { CoreAddResult, CoreMaterializeReport, CoreOutcome } from "../../loader/core.js"
import { installLoader, reportTuiPlugin } from "../loader"
import { git, requireGit } from "../git"
import { OCM_LINKS_DIR, OPENCODE_GLOBAL_CONFIG } from "../paths"
import { queueFact, reportRestart, reportUpgrade, reportWarnings, componentSummary, outcomeComponents } from "../report"
import { printTrustListing, promptTrust } from "./trust-prompt"

export interface AddOptions {
  explicit?: boolean
  name?: string
  ref?: string
  trust?: boolean
}

// spec 05 add, minus the dialog: the core registers, decides trust from the
// flag, saves and materializes; the CLI renders and prompts (spec 10a)
export async function add(source: string, options: AddOptions = {}): Promise<void> {
  // the clone line must not state a false fact: the core refuses a duplicate
  // url or name before it clones — the same predicate decides both
  if (isGitUrl(source)) {
    const parsed = parseSource(source)
    const wanted = options.name ? normaliseMarketplaceName(options.name) : parsed.name
    if (!duplicateRefusal(readRegistry(), parsed, wanted)) {
      requireGit()
      console.log(`cloning ${parsed.url}...`)
    }
  }
  let result: CoreAddResult
  try {
    result = await addMarketplace(source, options)
  } catch (err) {
    // a refused add still owes the user the diagnostics behind the refusal
    // (spec 06); they ride the error as data — the core never prints
    const warnings = (err as { warnings?: unknown }).warnings
    if (Array.isArray(warnings)) reportWarnings(warnings)
    throw err
  }
  reportWarnings(result.warnings)
  // the loader files do not depend on the trust decision, so they precede the
  // prompt: an interrupt cannot skip them (spec 16). A re-print of an
  // already-current loader is not news (spec 23 §2); the TUI line is a
  // notice and waits for the headline (spec 23 §6)
  const tuiInstalled = installLoader(false)
  // a prompted decision re-materializes: the two passes are reported as one —
  // outcomes union, warnings union. A grant makes pass 1's "blocked
  // (untrusted)" lines false, so they do not carry over
  const reports: CoreMaterializeReport[] = [result.report]
  let warnings = result.report.warnings
  if (options.trust === true && result.trustComponents.length) {
    // a blind grant is a security decision made without seeing the question
    printTrustListing(result.name, result.dir, result.trustComponents)
  }
  if (result.trustComponents.length && options.trust === undefined) {
    const decision = await promptTrust(result.name, result.dir, result.trustComponents, () => {
      console.error(`interrupted — marketplace "${result.name}" is added and materialized`)
      console.error("  trust: undecided (executable components are blocked)")
      console.error(`  run \`ocm trust ${result.name}\` to decide, or \`ocm remove ${result.name}\` to undo`)
    })
    if (decision === "granted" || decision === "denied") {
      const second = decision === "granted" ? await grantTrust(result.name) : await denyTrust(result.name)
      if (second.report) {
        reports.push(second.report)
        const carry = decision === "granted"
          ? warnings.filter((warning) => !warning.startsWith("blocked (untrusted): "))
          : warnings
        warnings = [...new Set([...carry, ...second.report.warnings])]
      }
    } else {
      skipTrust(result.name)
    }
  }
  // spec 20 F28: a config that does not parse was never written — say so and
  // show the exact edit instead of counting the skill as installed. Brief 31
  // §4: the check reads the outcomes, not the shim's counts
  const skillsNotWritten =
    result.report.outcomes.some((o) => o.type === "skill" && (o.state === "created" || o.state === "current")) && configIsCorrupt()
  // brief 31 §7 (F107): queued first so the loader's phrasings of the same
  // unparseable-config fact dedupe into this one, which names the remedy
  if (skillsNotWritten) {
    queueFact("config-unparseable", OPENCODE_GLOBAL_CONFIG, () => {
      console.error("warning: skills.paths NOT written — opencode.json is not valid JSON")
      console.error(`  add "${join(OCM_LINKS_DIR, result.name, "skills")}" to skills.paths by hand`)
    })
  }
  reportWarnings([...new Set(warnings)])
  // spec 23 §6: the headline precedes the notices
  const partial = reportAdded(result, skillsNotWritten, reports.flatMap((report) => report.outcomes))
  if (tuiInstalled) reportTuiPlugin()
  reportRestart(reports)
  reportUpgrade(result.wasV1)
  // brief 45 §3: a withheld component is not an install — exit 1 once at
  // the end, after every plugin line has printed
  if (partial) process.exitCode = 1
}

// undefined and valid are both fine: only a present-but-unparseable config
// silently swallows the skills.paths write
function configIsCorrupt(): boolean {
  let raw: string
  try {
    raw = readFileSync(OPENCODE_GLOBAL_CONFIG, "utf8")
  } catch {
    return false
  }
  try {
    JSON.parse(raw)
    return false
  } catch {
    return true
  }
}

// brief 45 §1/§3 (F211, F260): the per-plugin line is derived from the run's
// outcomes — what materialized, singular where one; a withheld component
// makes the plugin partial. Explicit mode is an availability listing, so it
// keeps discovery's counts. Returns whether any plugin was partial
function reportAdded(result: CoreAddResult, skillsNotWritten: boolean, allOutcomes: CoreOutcome[]): boolean {
  console.log(`added marketplace "${result.name}"`)
  let partial = false
  for (const plugin of result.plugins) {
    const mine = allOutcomes.filter((o) => o.plugin === plugin.name)
    const withheld = mine.filter((o) => o.skip === "unowned-dest")
    if (withheld.length > 0) {
      partial = true
      console.log(`  ${plugin.name} installed partially — ${withheld.length} component${withheld.length === 1 ? "" : "s"} withheld`)
      continue
    }
    if (result.mode === "explicit") {
      console.log(`  ${plugin.name} (${componentSummary(plugin.components)}) — available, not installed`)
      continue
    }
    const components = outcomeComponents(mine)
    // brief 31 §4: a config that does not parse swallowed the skills.paths
    // write — the skill is not counted as installed
    if (skillsNotWritten) delete components.skill
    const summary = componentSummary(components)
    console.log(`  ${plugin.name}${summary ? ` (${summary})` : ""}`)
  }
  // spec 23 §8: in explicit mode nothing is installed — the closing line
  // names the verb that activates
  if (result.mode === "explicit") {
    console.log(`${result.plugins.length} plugins available — ocm install <name> to activate`)
  } else {
    console.log("commands and agents are available as /<plugin>:<name> in every project")
  }
  return partial
}

export function remove(name: string): void {
  const result = removeMarketplace(name)
  reportWarnings(result.warnings)
  reportUpgrade(result.wasV1)
  // brief 47 §2 (F273): the counts come from the teardown's outcomes, not
  // the records — a marketplace added --explicit with nothing installed must
  // not report deletions that never happened
  const removed = result.report.outcomes.filter((o) => o.state === "removed")
  console.log(`removed marketplace "${result.name}"${removed.length ? "" : " — nothing was installed"}`)
  for (const plugin of [...new Set(removed.map((o) => o.plugin))]) {
    const summary = componentSummary(outcomeComponents(removed.filter((o) => o.plugin === plugin), ["removed"]))
    console.log(`  ${plugin}: ${summary} removed`)
  }
  // brief 33 §3 (F70): one line per freed name — no restart notice,
  // nothing on disk changed
  for (const item of result.freed) {
    console.log(`  ${item.plugin}@${item.marketplace}: the name is free again — ocm install ${item.plugin}@${item.marketplace} to enable it`)
  }
  for (const line of result.restore) console.log(line)
  // brief 31 §6: the notice follows the teardown's outcomes, after the
  // headline and the per-plugin lines
  reportRestart(result.report)
}

// spec 08: pinning is branch- and tag-following, never commit-freezing; the
// core validates the ref by fetching it before saving it
// spec 25 §5: with no ref, the remote's heads and tags are listed and one is
// prompted for; non-interactive it errors listing them, saving nothing
export async function pin(name: string, ref?: string, clear = false): Promise<void> {
  if (!ref && !clear) ref = await choosePinRef(name)
  const result = await pinMarketplace(name, clear ? null : ref)
  reportUpgrade(result.wasV1)
  console.log(clear
    ? `marketplace "${name}" unpinned (following the default branch)`
    : `marketplace "${name}" pinned to ${ref}`)
}

function remoteRefs(url: string): string[] {
  const run = git(["ls-remote", "--heads", "--tags", url])
  if (!run.ok) throw new Error(`cannot list refs for ${url} — ${run.stderr || run.stdout}`)
  const refs = run.stdout.split("\n").filter(Boolean)
    .map((line) => line.split("\t")[1]!)
    .filter((ref) => !ref.endsWith("^{}"))
    .map((ref) => ref.replace(/^refs\/(heads|tags)\//, ""))
  return [...new Set(refs)]
}

async function choosePinRef(name: string): Promise<string> {
  const entry = readRegistry().marketplaces[name]
  if (!entry) throw new Error(`marketplace "${name}" not found (ocm list)`)
  if (entry.local) throw new Error(`marketplace "${name}" is local; nothing to pin`)
  const refs = remoteRefs(entry.url)
  if (!process.stdin.isTTY) {
    throw new Error(`missing ref for "${name}" — available refs: ${refs.join(", ")}\n  ocm pin ${name} <ref>`)
  }
  console.log(`refs available for "${name}":`)
  for (const ref of refs) console.log(`  ${ref}`)
  const { createInterface } = await import("node:readline/promises")
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question("pin to which ref? ")).trim()
    if (!refs.includes(answer)) throw new Error(`"${answer}" is not an available ref: ${refs.join(", ")}`)
    return answer
  } finally {
    rl.close()
  }
}
