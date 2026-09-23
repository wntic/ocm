import { OCM_REGISTRY_FILE } from "./paths"
import { approvedComponents, componentKey, componentRoot, enabledPlugins, executableComponents, readRegistry } from "../loader/core.js"
import type { CoreMaterializeReport, CoreOutcome, CorePluginComponents, CoreState } from "../loader/core.js"

const BLOCKED_PREFIX = "blocked (untrusted): "

export function componentSummary(components: CorePluginComponents): string {
  const parts: string[] = []
  for (const [type, files] of Object.entries(components)) {
    if (files?.length) parts.push(`${files.length} ${type}${files.length === 1 ? "" : "s"}`)
  }
  return parts.join(", ")
}

// brief 45 §1: the components a run materialized, derived from its outcomes
// the same way deriveComponents derives the registry record
// (loader/marketplace.js). Brief 47 §2: the teardown passes ["removed"] to
// count what it took down
export function outcomeComponents(outcomes: CoreOutcome[], states: CoreState[] = ["created", "current", "refreshed"]): CorePluginComponents {
  const components: CorePluginComponents = {}
  for (const type of ["command", "agent", "skill", "plugin", "mcp"] as const) {
    const names = [
      ...new Set(
        outcomes
          .filter((o) => o.type === type && states.includes(o.state))
          .map((o) => o.component),
      ),
    ].sort()
    if (names.length) components[type] = names
  }
  return components
}

// brief 31 §7: one fact, once per run. A fact is keyed (kind, subject), not
// by its rendered string — F107 is two phrasings of one fact
const facts = new Map<string, () => void>()
const notices: string[] = []
let restartNeeded = false
let mutated = false

export function queueFact(kind: string, subject: string, render: () => void): void {
  const key = `${kind}\n${subject}`
  if (!facts.has(key)) facts.set(key, render)
}

export function queueNotice(line: string): void {
  notices.push(line)
}

// the flush scan (F100) is a mutation's debt: only a command that wrote owes
// the user the pending-trust line for marketplaces it never touched
export function markMutation(): void {
  mutated = true
}

// F107: the loader reports one unparseable config in two phrasings; both are
// one fact keyed by the path
function configSubject(warning: string): string | null {
  const skipped = warning.match(/^skipped (.*): not valid JSON, left untouched$/)
  if (skipped) return skipped[1]!
  const plain = warning.match(/^(.*) is not valid JSON, left untouched$/)
  if (plain) return plain[1]!
  return null
}

function queueWarning(warning: string): void {
  const config = configSubject(warning)
  if (config !== null) {
    queueFact("config-unparseable", config, () =>
      console.error(`  warning: ${config} is not valid JSON, left untouched — fix or remove it, then re-run`))
    return
  }
  queueFact("warning", warning, () => console.error(`  warning: ${warning}`))
}

export function reportWarnings(warnings: string[]): void {
  for (const warning of warnings) queueWarning(warning)
}

// brief 31 §7 (F105): a mutation's warnings are scoped to what it touched —
// blocked lines are the flush scan's one fact (F100), and another plugin's
// withheld reasons are not this command's news
export function reportMutationWarnings(report: CoreMaterializeReport, scope: { marketplace: string; plugin?: string }): void {
  const outOfScope = new Set(
    scope.plugin === undefined
      ? []
      : report.outcomes.filter((o) => o.plugin !== scope.plugin && o.reason !== null).map((o) => o.reason),
  )
  for (const warning of report.warnings) {
    if (warning.startsWith(BLOCKED_PREFIX)) continue
    if (outOfScope.has(warning)) continue
    queueWarning(warning)
  }
}

// brief 31 §6: the notice follows what the outcomes say moved — anything
// created, removed or refreshed needs a restart to take effect (brief 45 §5:
// nothing reloads in-session, so a refreshed body needs one exactly as a
// created one does)
export function outcomesNeedRestart(outcomes: CoreOutcome[] | null): boolean {
  return (outcomes ?? []).some((o) => o.state === "created" || o.state === "removed" || o.state === "refreshed")
}

export function reportRestart(reports: CoreMaterializeReport | CoreMaterializeReport[]): void {
  const list = Array.isArray(reports) ? reports : [reports]
  if (list.some((report) => outcomesNeedRestart(report.outcomes))) restartNeeded = true
}

// brief 31 §7 (F100): a pending-trust fact is run-level — at flush, every
// marketplace with blocked executables owes the user the one line, whether
// or not this command touched it
function scanPendingTrust(): void {
  if (!mutated) return
  for (const [name, entry] of Object.entries(readRegistry().marketplaces ?? {})) {
    let blocked = 0
    try {
      const root = componentRoot(entry)
      const enabled = enabledPlugins(entry, root)
      if (enabled) {
        const approved = approvedComponents(root, entry)
        for (const component of executableComponents(root, entry)) {
          if (enabled.has(component.plugin) && !approved.get(componentKey(component.kind, component.plugin, component.name))) blocked += 1
        }
      }
    } catch {}
    if (blocked > 0) {
      queueFact("trust-pending", name, () =>
        console.error(`  warning: ${blocked} component${blocked === 1 ? "" : "s"} blocked pending trust — run \`ocm trust ${name}\``))
    }
  }
}

// brief 31 §7: the fixed position — the verb's headline prints directly, then
// loader/TUI notices, then warnings, then the restart notice
export function flushReportSink(): void {
  scanPendingTrust()
  for (const line of notices) console.log(line)
  for (const render of facts.values()) render()
  if (restartNeeded) console.log("restart opencode to activate")
}

export function reportUpgrade(wasV1: boolean): void {
  if (wasV1) console.log(`registry upgraded v1 → v2 (${OCM_REGISTRY_FILE})`)
}
