// The trust flows of the /ocm TUI dialog (spec 10b): the prompt renders the
// same component list the CLI prints before a trust decision (spec 07).
import { componentRoot, denyTrust, executableComponents, grantTrust, readRegistry } from "./core.js"
import { NOTICE, confirm, message, toast } from "./ui-dialog.js"

// the same block the CLI prints before a trust prompt (spec 07)
function trustMessage(name, dir, components) {
  const lines = [`marketplace "${name}" ships code that opencode will execute:`]
  for (const component of components) {
    if (component.kind === "plugin") {
      lines.push(`  plugin  ${component.plugin}/${component.name.replace(/\.[jt]s$/, "")} (${component.rel})`)
    } else {
      const value = component.value
      const command = Array.isArray(value?.command) ? value.command.join(" ") : ""
      const detail = value && typeof value.url === "string" ? `remote server: ${value.url}` : `local server: ${command}`
      lines.push(`  mcp     ${component.plugin}/${component.name} (${detail})`)
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
    const result = grantTrust(name)
    if (result.report?.warnings.length) toast(api, "warning", result.report.warnings.join("\n"))
    toast(api, "success", `marketplace "${name}" trusted to run code — ${NOTICE}`)
  } catch (err) {
    toast(api, "error", message(err))
  }
  back()
}

export async function untrustFlow(api, name, back) {
  const text = `stop trusting marketplace "${name}"?\n\nits executable components are removed from opencode`
  if (!(await confirm(api, name, text))) {
    back()
    return
  }
  try {
    const result = denyTrust(name)
    if (result.report.warnings.length) toast(api, "warning", result.report.warnings.join("\n"))
    toast(api, "success", `marketplace "${name}" no longer trusted — ${NOTICE}`)
  } catch (err) {
    toast(api, "error", message(err))
  }
  back()
}

export { trustMessage }
