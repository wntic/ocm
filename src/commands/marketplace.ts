import { addMarketplace, denyTrust, grantTrust, isGitUrl, normaliseMarketplaceName, parseSource, pinMarketplace, readRegistry, removeMarketplace } from "../../loader/core.js"
import type { CoreAddResult } from "../../loader/core.js"
import { installLoader } from "../loader"
import { reportRestart, reportUpgrade, reportWarnings } from "../report"
import { promptTrust } from "./trust"

export interface AddOptions {
  explicit?: boolean
  name?: string
  ref?: string
  trust?: boolean
}

// spec 05 add, minus the dialog: the core registers, decides trust from the
// flag, saves and materializes; the CLI renders and prompts (spec 10a)
export async function add(source: string, options: AddOptions = {}): Promise<void> {
  // the clone line must not state a false fact: the core refuses an
  // already-added name before it clones
  if (isGitUrl(source)) {
    const parsed = parseSource(source)
    const wanted = options.name ? normaliseMarketplaceName(options.name) : parsed.name
    if (!readRegistry().marketplaces[wanted]) console.log(`cloning ${parsed.url}...`)
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
  // a prompted decision re-materializes: the two passes are reported as one —
  // created links sum, warnings union. A grant makes pass 1's "blocked
  // (untrusted)" lines false, so they do not carry over
  let created = result.report.created
  let warnings = result.report.warnings
  if (result.trustComponents.length && options.trust === undefined) {
    const decision = await promptTrust(result.name, result.dir, result.trustComponents)
    if (decision === "granted" || decision === "denied") {
      const second = decision === "granted" ? await grantTrust(result.name) : await denyTrust(result.name)
      if (second.report) {
        created += second.report.created
        const carry = decision === "granted"
          ? warnings.filter((warning) => !warning.startsWith("blocked (untrusted): "))
          : warnings
        warnings = [...new Set([...carry, ...second.report.warnings])]
      }
    }
  }
  reportWarnings(warnings)
  reportRestart(created)
  installLoader()
  reportUpgrade(result.wasV1)
  reportAdded(result)
}

function reportAdded(result: CoreAddResult): void {
  console.log(`added marketplace "${result.name}"`)
  for (const plugin of result.plugins) {
    const parts: string[] = []
    if (plugin.components.agent) parts.push(`${plugin.components.agent.length} agents`)
    if (plugin.components.command) parts.push(`${plugin.components.command.length} commands`)
    if (plugin.components.skill) parts.push(`${plugin.components.skill.length} skills`)
    if (plugin.components.plugin) parts.push(`${plugin.components.plugin.length} plugins`)
    if (plugin.components.mcp) parts.push(`${plugin.components.mcp.length} mcp servers`)
    const available = result.mode === "explicit" ? " — available, not installed" : ""
    console.log(`  ${plugin.name} (${parts.join(", ")})${available}`)
  }
  console.log("commands and agents are available as /<plugin>:<name> in every project")
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
}

// spec 08: pinning is branch- and tag-following, never commit-freezing; the
// core validates the ref by fetching it before saving it
export async function pin(name: string, ref?: string, clear = false): Promise<void> {
  const result = await pinMarketplace(name, clear ? null : ref)
  reportUpgrade(result.wasV1)
  console.log(clear
    ? `marketplace "${name}" unpinned (following the default branch)`
    : `marketplace "${name}" pinned to ${ref}`)
}
