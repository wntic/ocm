import { relative } from "node:path"

// one outcome per linked component; a skipped or refused link carries the
// warning link() pushed for it as its reason
export function linkOutcome(st, type, plugin, component, source, dest, status, warnStart) {
  let state = status === "ok" ? "current" : status
  if (state === "current" && st.changed !== null && st.changed.has(relative(st.dir, source))) state = "refreshed"
  let reason = null
  if (state === "skipped" || state === "refused") {
    reason = st.ctx.warnings.length > warnStart ? st.ctx.warnings[st.ctx.warnings.length - 1] : null
  }
  const outcome = { type, plugin, component, source, dest, state, reason }
  if (st.ctx.displacements.has(dest)) outcome.displaced = st.ctx.displacements.get(dest)
  st.outcomes.push(outcome)
}

export function removedOutcome(st, type, plugin, component, dest) {
  st.outcomes.push({ type, plugin, component, source: null, dest, state: "removed", reason: null })
}
