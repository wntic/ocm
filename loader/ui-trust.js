// The trust flows of the /ocm TUI dialog (spec 10b): the prompt renders the
// same component list the CLI prints before a trust decision (spec 07).
import { existsSync } from "node:fs"
import { componentRoot, denyTrust, executableComponents, grantTrust, readRegistry, withRegistryLock } from "./core.js"
import { mcpTrustLine } from "./mcp-line.js"
import { untrustHeadline } from "./untrust-line.js"
import { NOTICE, message, toast } from "./ui-dialog.js"
import { confirm } from "./ui-modals.js"

// the same block the CLI prints before a trust prompt (spec 07)
function trustMessage(name, dir, components) {
  const lines = [`marketplace "${name}" ships code that opencode will execute:`]
  for (const component of components) {
    if (component.kind === "plugin") {
      lines.push(`  plugin  ${component.plugin}/${component.name.replace(/\.[jt]s$/, "")} (${component.rel})`)
    } else {
      lines.push(mcpTrustLine(component))
    }
  }
  lines.push("this code runs with your shell's permissions on every opencode start.")
  lines.push(`review it at ${dir}`)
  lines.push("trust this marketplace to run code?")
  return lines.join("\n")
}

export async function trustFlow(api, name, back) {
  const entry = readRegistry().marketplaces?.[name]
  if (!entry) {
    toast(api, "error", `marketplace "${name}" not found (ocm list)`)
    back()
    return
  }
  const components = executableComponents(componentRoot(entry), entry)
  if (!components.length) {
    toast(api, "info", `marketplace "${name}" ships no code; nothing to trust`)
    back()
    return
  }
  if (!(await confirm(api, name, trustMessage(name, entry.dir, components)))) {
    back()
    return
  }
  try {
    const result = await withRegistryLock("ocm trust " + name + " (tui)", () => grantTrust(name))
    if (result.report?.warnings.length) toast(api, "warning", result.report.warnings.join("\n"))
    toast(api, "success", `marketplace "${name}" trusted to run code — ${NOTICE}`)
  } catch (err) {
    toast(api, "error", message(err))
  }
  back()
}

// brief 48 §4: the same "ships nothing executable" test the CLI's display
// helper makes — the tree positively ships nothing, false when it cannot
// be read
function shipsNoExecutables(entry) {
  try {
    const root = componentRoot(entry)
    return existsSync(root) && executableComponents(root, entry).length === 0
  } catch {
    return false
  }
}

export async function untrustFlow(api, name, back) {
  const text = `stop trusting marketplace "${name}"?\n\nits executable components are removed from opencode`
  if (!(await confirm(api, name, text))) {
    back()
    return
  }
  try {
    const result = await withRegistryLock("ocm untrust " + name + " (tui)", () => denyTrust(name))
    if (result.report.warnings.length) toast(api, "warning", result.report.warnings.join("\n"))
    const removed = result.report.outcomes.some((o) => o.state === "removed")
    const entry = readRegistry().marketplaces?.[name]
    toast(api, "success", `${untrustHeadline(name, removed, result.wasGranted, shipsNoExecutables(entry))}${removed ? ` — ${NOTICE}` : ""}`)
  } catch (err) {
    toast(api, "error", message(err))
  }
  back()
}

export { trustMessage }
