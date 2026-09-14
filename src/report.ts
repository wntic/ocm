import { OCM_REGISTRY_FILE } from "./paths"

const BLOCKED_PREFIX = "blocked (untrusted): "

export function reportWarnings(warnings: string[]): void {
  for (const warning of warnings) console.error(`  warning: ${warning}`)
}

// spec 23 §7: a mutation re-printing an untrusted marketplace's blocked
// components is noise — one summary line per run instead
export function reportMutationWarnings(warnings: string[], marketplace: string): void {
  let blocked = 0
  for (const warning of warnings) {
    if (warning.startsWith(BLOCKED_PREFIX)) blocked += 1
    else console.error(`  warning: ${warning}`)
  }
  if (blocked > 0) {
    console.error(`  warning: ${blocked} component${blocked === 1 ? "" : "s"} blocked pending trust — run \`ocm trust ${marketplace}\``)
  }
}

export function reportRestart(changed: number): void {
  if (changed > 0) console.log("restart opencode to activate")
}

export function reportUpgrade(wasV1: boolean): void {
  if (wasV1) console.log(`registry upgraded v1 → v2 (${OCM_REGISTRY_FILE})`)
}
