// brief 34 §2: the mcp line of a trust listing, shared by the CLI prompt and
// the TUI dialog so the two blocks stay byte-identical (spec 07). Every
// command form renders; an entry the shape guard rejects stays in the
// listing — it is in the fingerprint — but is annotated as not installed.
import { mcpShapeError } from "./discovery.js"

export function mcpTrustLine(component) {
  const value = component.value
  let detail
  if (value && typeof value.url === "string" && value.url) {
    detail = `remote server: ${value.url}`
  } else {
    let command = ""
    if (Array.isArray(value?.command)) command = value.command.join(" ")
    else if (typeof value?.command === "string" && value.command) {
      const args = Array.isArray(value?.args) ? value.args : []
      command = [value.command, ...args].join(" ")
    }
    detail = command ? `local server: ${command}` : "local server: (no command in mcp.json)"
  }
  const line = `  mcp     ${component.plugin}/${component.name} (${detail})`
  return mcpShapeError(value) === null ? line : `${line} — invalid shape, will not be installed`
}
