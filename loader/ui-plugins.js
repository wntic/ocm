// The per-plugin flows of the /ocm TUI dialog (spec 10b): the plugin menu,
// install/uninstall, and the details view.
import { readRegistry, setEnabled } from "./core.js"
import { NOTICE, alert, componentSummary, confirm, message, select, toast } from "./ui-dialog.js"
import { openBrowse } from "./ui.js"
import { updateFlow } from "./ui-marketplaces.js"
import { trustFlow } from "./ui-trust.js"

// executable components ship blocked until the marketplace is trusted (spec 07)
export function blocked(record, entry) {
  const components = record.components ?? {}
  if (!(components.plugin?.length || components.mcp?.length)) return false
  return entry.trust?.code !== "granted" || entry.trustPending === true
}

export function openPlugin(api, marketplace, name) {
  const entry = readRegistry().marketplaces?.[marketplace]
  const record = entry?.plugins?.[name]
  if (!entry || !record) {
    openBrowse(api)
    return
  }
  const arg = `${name}@${marketplace}`
  const options = [
    { title: record.enabled ? "Uninstall" : "Install", value: "toggle", description: componentSummary(record) },
    { title: "Details", value: "details", description: "The ocm info record" },
  ]
  if (blocked(record, entry)) {
    options.push({ title: "Trust marketplace", value: "trust", description: `Approve executable components from ${marketplace}` })
  }
  options.push(
    { title: `Update ${marketplace}`, value: "update", description: "Pull just this marketplace" },
    { title: "Back", value: "back", description: "Back to the plugin list" },
  )
  select(api, {
    title: arg,
    options,
    onSelect: (option) => {
      if (option.value === "toggle") togglePlugin(api, marketplace, name)
      else if (option.value === "details") showDetails(api, marketplace, name)
      else if (option.value === "trust") trustFlow(api, marketplace, () => openPlugin(api, marketplace, name))
      else if (option.value === "update") updateFlow(api, marketplace, () => openPlugin(api, marketplace, name))
      else openBrowse(api)
    },
  })
}

async function togglePlugin(api, marketplace, name) {
  const entry = readRegistry().marketplaces?.[marketplace]
  const record = entry?.plugins?.[name]
  if (!entry || !record) {
    openBrowse(api)
    return
  }
  const arg = `${name}@${marketplace}`
  const enabling = !record.enabled
  const executable = (record.components?.plugin?.length ?? 0) + (record.components?.mcp?.length ?? 0)
  let text = enabling ? `Install ${arg} (${componentSummary(record)})?` : `Uninstall ${arg}?`
  if (!enabling && executable) text += `\n\nit removes ${executable} executable component(s) opencode runs on start`
  if (!(await confirm(api, arg, text))) {
    openPlugin(api, marketplace, name)
    return
  }
  try {
    const result = setEnabled(arg, enabling)
    if (result.disagreement) toast(api, "warning", result.disagreement)
    if (result.report.warnings.length) toast(api, "warning", result.report.warnings.join("\n"))
    toast(api, "success", `${enabling ? "installed" : "uninstalled"} ${arg} — ${NOTICE}`)
  } catch (err) {
    toast(api, "error", message(err))
  }
  openBrowse(api)
}

function showDetails(api, marketplace, name) {
  const entry = readRegistry().marketplaces?.[marketplace]
  const record = entry?.plugins?.[name]
  if (!entry || !record) {
    openBrowse(api)
    return
  }
  const manifest = record.manifest ?? {}
  const lines = [`${name} @ ${marketplace}`]
  if (manifest.description) lines.push(`description: ${manifest.description}`)
  if (record.version) lines.push(`version: ${record.version}`)
  if (manifest.category) lines.push(`category: ${manifest.category}`)
  lines.push(`enabled: ${record.enabled ? "yes" : "no"}`)
  lines.push(`installed: ${record.installedAt ?? "no"}`)
  lines.push(`marketplace: ${entry.url}${entry.ref ? ` @ ${entry.ref}` : ""}`)
  lines.push(`trust: ${entry.trust?.code ?? "none"}`)
  const components = record.components ?? {}
  const named = [
    ...(components.command ?? []).map((file) => `command ${name}:${file}`),
    ...(components.agent ?? []).map((file) => `agent ${name}:${file}`),
    ...(components.skill ?? []).map((rel) => `skill ${name}:${rel}`),
    ...(components.plugin ?? []).map((file) => `plugin ocm--${name}--${file}`),
    ...(components.mcp ?? []).map((server) => `mcp ocm--${name}--${server}`),
  ]
  if (named.length) lines.push("components:", ...named.map((line) => `  ${line}`))
  alert(api, `${name}@${marketplace}`, lines.join("\n"), () => openPlugin(api, marketplace, name))
}
