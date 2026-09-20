import { readFileSync } from "node:fs"
import { join } from "node:path"
import { addMarketplace, denyTrust, duplicateRefusal, grantTrust, isGitUrl, normaliseMarketplaceName, parseSource, pinMarketplace, readRegistry, removeMarketplace, skipTrust } from "../../loader/core.js"
import type { CoreAddResult } from "../../loader/core.js"
import { installLoader, reportTuiPlugin } from "../loader"
import { git } from "../git"
import { OCM_LINKS_DIR, OPENCODE_GLOBAL_CONFIG } from "../paths"
import { reportRestart, reportUpgrade, reportWarnings } from "../report"
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
    if (!duplicateRefusal(readRegistry(), parsed, wanted)) console.log(`cloning ${parsed.url}...`)
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
  // created links sum, warnings union. A grant makes pass 1's "blocked
  // (untrusted)" lines false, so they do not carry over
  let created = result.report.created
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
        created += second.report.created
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
  // show the exact edit instead of counting the skill as installed
  const skillsNotWritten = result.report.counts.skill > 0 && configIsCorrupt()
  reportWarnings([...new Set(warnings)])
  if (skillsNotWritten) {
    console.error("skills.paths NOT written — opencode.json is not valid JSON")
    console.error(`  add "${join(OCM_LINKS_DIR, result.name, "skills")}" to skills.paths by hand`)
  }
  // spec 23 §6: the headline precedes the notices
  reportAdded(result, skillsNotWritten)
  if (tuiInstalled) reportTuiPlugin()
  reportRestart(created)
  reportUpgrade(result.wasV1)
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

function reportAdded(result: CoreAddResult, skillsNotWritten: boolean): void {
  console.log(`added marketplace "${result.name}"`)
  for (const plugin of result.plugins) {
    const parts: string[] = []
    if (plugin.components.agent) parts.push(`${plugin.components.agent.length} agents`)
    if (plugin.components.command) parts.push(`${plugin.components.command.length} commands`)
    if (plugin.components.skill && !skillsNotWritten) parts.push(`${plugin.components.skill.length} skills`)
    if (plugin.components.plugin) parts.push(`${plugin.components.plugin.length} plugins`)
    if (plugin.components.mcp) parts.push(`${plugin.components.mcp.length} mcp servers`)
    const available = result.mode === "explicit" ? " — available, not installed" : ""
    console.log(`  ${plugin.name} (${parts.join(", ")})${available}`)
  }
  // spec 23 §8: in explicit mode nothing is installed — the closing line
  // names the verb that activates
  if (result.mode === "explicit") {
    console.log(`${result.plugins.length} plugins available — ocm install <name> to activate`)
  } else {
    console.log("commands and agents are available as /<plugin>:<name> in every project")
  }
}

export function remove(name: string): void {
  const result = removeMarketplace(name)
  reportWarnings(result.warnings)
  reportUpgrade(result.wasV1)
  console.log(`removed marketplace "${result.name}"`)
  for (const plugin of result.owned) {
    const parts: string[] = []
    if (plugin.components.agent) parts.push(`${plugin.components.agent.length} agents`)
    if (plugin.components.command) parts.push(`${plugin.components.command.length} commands`)
    if (plugin.components.skill) parts.push(`${plugin.components.skill.length} skills`)
    if (plugin.components.plugin) parts.push(`${plugin.components.plugin.length} plugins`)
    if (plugin.components.mcp) parts.push(`${plugin.components.mcp.length} mcp servers`)
    console.log(`  ${plugin.name}: ${parts.join(", ")} removed`)
  }
  for (const line of result.restore) console.log(line)
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
