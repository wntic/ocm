// The marketplace flows of the /ocm TUI dialog (spec 10b): list,
// per-marketplace menu, add/remove/update/pin, and update-all.
import {
  addMarketplace,
  componentRoot,
  enabledPlugins,
  grantTrust,
  materialize,
  pinMarketplace,
  pullRepo,
  readRegistry,
  removeMarketplace,
  syncAll,
} from "./core.js"
import { NOTICE, alert, componentSummary, confirm, message, prompt, select, toast } from "./ui-dialog.js"
import { openMainMenu } from "./ui.js"
import { trustFlow, trustMessage, untrustFlow } from "./ui-trust.js"

function busy(api, text) {
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({ title: "ocm", options: [{ title: text, value: "busy" }], onSelect: () => {} }),
  )
}

export function openMarketplaces(api) {
  const options = Object.entries(readRegistry().marketplaces ?? {}).map(([name, entry]) => ({
    title: name,
    value: name,
    description: entry.local ? `${entry.url} (local)` : entry.url,
  }))
  options.push(
    { title: "Add", value: "add", description: "Add a marketplace from a URL or path" },
    { title: "Back", value: "back", description: "Back to the main menu" },
  )
  select(api, {
    title: "Marketplaces",
    options,
    onSelect: (option) => {
      if (option.value === "add") addMarketplaceFlow(api, () => openMarketplaces(api))
      else if (option.value === "back") openMainMenu(api)
      else openMarketplace(api, option.value)
    },
  })
}

function openMarketplace(api, name) {
  const entry = readRegistry().marketplaces?.[name]
  if (!entry) {
    toast(api, "error", `marketplace "${name}" not found (ocm list)`)
    openMarketplaces(api)
    return
  }
  const trusted = entry.trust?.code === "granted"
  select(api, {
    title: name,
    options: [
      { title: "Update", value: "update", description: "Pull latest changes and refresh links" },
      { title: "Remove", value: "remove", description: "Remove this marketplace and its links" },
      {
        title: trusted ? "Untrust" : "Trust",
        value: "trust",
        description: trusted ? "Remove its executable components" : "Approve its executable components",
      },
      { title: "Pin", value: "pin", description: "Follow a specific branch or tag" },
      { title: "Back", value: "back", description: "Back to the marketplace list" },
    ],
    onSelect: (option) => {
      if (option.value === "update") updateFlow(api, name, () => openMarketplace(api, name))
      else if (option.value === "remove") removeFlow(api, name)
      else if (option.value === "trust") {
        const back = () => openMarketplace(api, name)
        if (trusted) untrustFlow(api, name, back)
        else trustFlow(api, name, back)
      } else if (option.value === "pin") pinFlow(api, name)
      else openMarketplaces(api)
    },
  })
}

export async function updateFlow(api, name, back) {
  const entry = readRegistry().marketplaces?.[name]
  if (!entry) {
    toast(api, "error", `marketplace "${name}" not found (ocm list)`)
    back()
    return
  }
  busy(api, `Updating ${name}...`)
  try {
    let changed = false
    if (entry.local === false) {
      const pull = await pullRepo(entry.dir, typeof entry.ref === "string" ? entry.ref : null)
      if (!pull.ok) throw new Error(pull.output)
      changed = pull.changed
    }
    const root = componentRoot(entry)
    const links = materialize(name, root, { enabled: enabledPlugins(entry, root) })
    if (links.warnings.length) toast(api, "warning", links.warnings.join("\n"))
    const mutated = changed || links.created > 0
    toast(api, "success", `${name}: ${changed ? "updated to a new revision" : "already up to date"}${mutated ? ` — ${NOTICE}` : ""}`)
  } catch (err) {
    toast(api, "error", `${name}: update failed: ${message(err)}`)
  }
  back()
}

async function removeFlow(api, name) {
  const entry = readRegistry().marketplaces?.[name]
  if (!entry) {
    toast(api, "error", `marketplace "${name}" not found (ocm list)`)
    openMarketplaces(api)
    return
  }
  const lines = [`remove marketplace "${name}"?`]
  for (const [plugin, record] of Object.entries(entry.plugins ?? {})) {
    if (!record.collision) lines.push(`  ${plugin} (${componentSummary(record)})`)
  }
  if (entry.local === false) lines.push(`the clone at ${entry.dir} is deleted`)
  if (!(await confirm(api, name, lines.join("\n")))) {
    openMarketplace(api, name)
    return
  }
  try {
    const result = removeMarketplace(name)
    if (result.warnings.length) toast(api, "warning", result.warnings.join("\n"))
    toast(api, "success", `removed marketplace "${name}" — ${NOTICE}`)
  } catch (err) {
    toast(api, "error", message(err))
  }
  openMarketplaces(api)
}

async function pinFlow(api, name) {
  const ref = await prompt(api, `Pin ${name}`, "Branch or tag to follow (empty to follow the default branch)")
  if (ref === null) {
    openMarketplace(api, name)
    return
  }
  try {
    const result = await pinMarketplace(name, ref || null)
    toast(api, "success", `marketplace "${name}" ${result.cleared ? "unpinned" : `pinned to ${result.ref}`} — ${NOTICE}`)
  } catch (err) {
    toast(api, "error", message(err))
  }
  openMarketplace(api, name)
}

export async function addMarketplaceFlow(api, back) {
  const source = await prompt(api, "Add marketplace", "URL or path of the marketplace to add")
  if (!source) {
    back()
    return
  }
  busy(api, `Adding ${source}...`)
  let result
  try {
    result = await addMarketplace(source)
  } catch (err) {
    // a refused add still owes the user the diagnostics behind the refusal
    if (Array.isArray(err.warnings) && err.warnings.length) toast(api, "warning", err.warnings.join("\n"))
    alert(api, "ocm", `error: ${message(err)}`, back)
    return
  }
  if (result.warnings.length) toast(api, "warning", result.warnings.join("\n"))
  if (result.trustComponents.length && (await confirm(api, result.name, trustMessage(result.name, result.dir, result.trustComponents)))) {
    const second = grantTrust(result.name)
    if (second.report?.warnings.length) toast(api, "warning", second.report.warnings.join("\n"))
  }
  toast(api, "success", `added marketplace "${result.name}" — ${NOTICE}`)
  back()
}

export async function runUpdateAll(api) {
  busy(api, "Updating all marketplaces...")
  try {
    const result = await syncAll({ force: true })
    const lines = []
    if (result.updated.length) lines.push(`updated: ${result.updated.join(", ")}`)
    if (result.unchanged.length) lines.push(`unchanged: ${result.unchanged.join(", ")}`)
    if (result.failed.length) lines.push(`failed: ${result.failed.join(", ")}`)
    for (const [name, error] of Object.entries(result.errors)) lines.push(`  ${name}: ${error}`)
    if (result.warnings?.length) lines.push(...result.warnings)
    if (result.changed) lines.push(NOTICE)
    alert(api, "ocm", lines.join("\n") || "no marketplaces added yet (ocm add <url|path>)", () => openMainMenu(api))
  } catch (err) {
    alert(api, "ocm", `error: ${message(err)}`, () => openMainMenu(api))
  }
}
