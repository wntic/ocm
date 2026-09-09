import { OCM_REGISTRY_FILE } from "./paths"

export function reportWarnings(warnings: string[]): void {
  for (const warning of warnings) console.error(`  warning: ${warning}`)
}

export function reportRestart(changed: number): void {
  if (changed > 0) console.log("restart opencode to activate")
}

export function reportUpgrade(wasV1: boolean): void {
  if (wasV1) console.log(`registry upgraded v1 → v2 (${OCM_REGISTRY_FILE})`)
}
