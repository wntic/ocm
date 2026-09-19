// The per-plugin flows of the /ocm TUI dialog (specs 10b, 22): the plugin
// menu, install/uninstall, and the details view.
import { readRegistry, setEnabled, withRegistryLock } from "./core.js"
import { NOTICE, backView, componentSummary, fit, message, pushView, select, toast } from "./ui-dialog.js"
import { confirm } from "./ui-modals.js"
import { updateFlow } from "./ui-marketplaces.js"
import { trustFlow } from "./ui-trust.js"

// executable components ship blocked until the marketplace is trusted (spec 07)
export function blocked(record, entry) {
  const components = record.components ?? {}
  if (!(components.plugin?.length || components.mcp?.length)) return false
  return entry.trust?.code !== "granted" || entry.trustPending === true
}

// spec 22 §4: the version sits next to the name, as `ocm info` prints it
export function pluginDetailLines(marketplace, name, entry) {
  const record = entry.plugins[name] ?? {}
  const manifest = record.manifest ?? {}
  const version = record.version ?? manifest.version
  const lines = [version ? `${name} ${version} @ ${marketplace}` : `${name} @ ${marketplace}`]
  if (manifest.description) lines.push(`description: ${manifest.description}`)
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
  return lines
}

export function openPlugin(api, marketplace, name) {
  const entry = readRegistry().marketplaces?.[marketplace]
  const record = entry?.plugins?.[name]
  if (!entry || !record) {
    toast(api, "error", `plugin "${name}" not found in "${marketplace}" (ocm list)`)
    backView(api)
    return
  }
  const arg = `${name}@${marketplace}`
  const render = () => openPlugin(api, marketplace, name)
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
      if (option.value === "toggle") togglePlugin(api, marketplace, name, render)
      else if (option.value === "details") pushView(api, () => showDetails(api, marketplace, name))
      else if (option.value === "trust") trustFlow(api, marketplace, render)
      else if (option.value === "update") updateFlow(api, marketplace, render)
      else backView(api)
    },
  })
}

// back: the plugin menu (a cancelled confirm returns there); a completed
// mutation returns to the list beneath, which refreshes in place
async function togglePlugin(api, marketplace, name, back) {
  const entry = readRegistry().marketplaces?.[marketplace]
  const record = entry?.plugins?.[name]
  if (!entry || !record) {
    backView(api)
    return
  }
  const arg = `${name}@${marketplace}`
  const enabling = !record.enabled
  const executable = (record.components?.plugin?.length ?? 0) + (record.components?.mcp?.length ?? 0)
  let text = enabling ? `Install ${arg} (${componentSummary(record)})?` : `Uninstall ${arg}?`
  if (!enabling && executable) text += `\n\nit removes ${executable} executable component(s) opencode runs on start`
  if (!(await confirm(api, arg, text))) {
    back()
    return
  }
  try {
    const result = await withRegistryLock(`ocm ${enabling ? "install" : "uninstall"} (tui)`, () => setEnabled(arg, enabling))
    if (result.disagreement) toast(api, "warning", result.disagreement)
    if (result.report.warnings.length) toast(api, "warning", result.report.warnings.join("\n"))
    const restore = result.restore.length ? `${result.restore.join("\n")}\n` : ""
    toast(api, "success", `${restore}${enabling ? "installed" : "uninstalled"} ${arg} — ${NOTICE}`)
  } catch (err) {
    toast(api, "error", message(err))
  }
  backView(api)
}

// spec 22 §2/§3: a select, not an alert — the body scrolls and the action row
// carries a visible back affordance. fit wraps each line to the select-row
// width of the chosen bucket, so no option title reaches the widget's
// ellipsis
function showDetails(api, marketplace, name) {
  const entry = readRegistry().marketplaces?.[marketplace]
  if (!entry || !entry.plugins?.[name]) {
    toast(api, "error", `plugin "${name}" not found in "${marketplace}" (ocm list)`)
    backView(api)
    return
  }
  const lines = fit(pluginDetailLines(marketplace, name, entry)).lines
  select(api, {
    title: `${name}@${marketplace}`,
    skipFilter: true,
    options: [
      ...lines.map((line, i) => ({ title: line, value: i })),
      { title: "← back", value: "back", description: "or press Escape" },
    ],
    onSelect: (option) => {
      if (option.value === "back") backView(api)
    },
  })
}
