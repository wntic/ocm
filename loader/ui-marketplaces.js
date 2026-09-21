// The marketplace flows of the /ocm TUI dialog (specs 10b, 22): list,
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
  withRegistryLock,
  syncAll,
} from "./core.js"
import { NOTICE, backView, componentSummary, message, pushView, select, toast } from "./ui-dialog.js"
import { marketplaceDetailLines, marketplaceRows } from "./ui-marketplace-data.js"
import { alert, confirm, prompt } from "./ui-modals.js"
import { openMainMenu } from "./ui.js"
import { trustFlow, trustMessage, untrustFlow } from "./ui-trust.js"

// re-exported: the data shapes stay importable from this module (spec 22 §4)
export { marketplaceDetailLines, marketplaceRows }

function busy(api, text) {
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({ title: "ocm", options: [{ title: text, value: "busy" }], onSelect: () => {} }),
  )
}

// spec 22 §3: the list is a stack view — it remembers its selection when back
// returns to it, and the marketplace menu is pushed on top of it
export function openMarketplaces(api) {
  const state = { current: null }
  const render = () => {
    const options = marketplaceRows(readRegistry())
    options.push(
      { title: "Add", value: "add", description: "Add a marketplace from a URL or path" },
      { title: "Back", value: "back", description: "Back to the main menu" },
    )
    select(api, {
      title: "Marketplaces",
      current: state.current,
      options,
      onSelect: (option) => {
        state.current = option.value
        if (option.value === "add") addMarketplaceFlow(api, render)
        else if (option.value === "back") backView(api)
        else pushView(api, () => openMarketplace(api, option.value))
      },
    })
  }
  pushView(api, render)
}

function openMarketplace(api, name) {
  const entry = readRegistry().marketplaces?.[name]
  if (!entry) {
    toast(api, "error", `marketplace "${name}" not found (ocm list)`)
    backView(api)
    return
  }
  const render = () => openMarketplace(api, name)
  const trusted = entry.trust?.code === "granted"
  select(api, {
    title: marketplaceDetailLines(name, entry).join("\n"),
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
      if (option.value === "update") updateFlow(api, name, render)
      else if (option.value === "remove") removeFlow(api, name, render)
      else if (option.value === "trust") {
        if (trusted) untrustFlow(api, name, render)
        else trustFlow(api, name, render)
      } else if (option.value === "pin") pinFlow(api, name, render)
      else backView(api)
    },
  })
}

export async function updateFlow(api, name, back) {
  const entry = readRegistry().marketplaces?.[name]
  if (!entry) {
    toast(api, "error", `marketplace "${name}" not found (ocm list)`)
    backView(api)
    return
  }
  busy(api, `Updating ${name}...`)
  try {
    const { changed, links } = await withRegistryLock(`ocm update ${name} (tui)`, async () => {
      let changed = false
      if (entry.local === false) {
        const pull = await pullRepo(entry, name)
        if (!pull.ok) throw new Error(pull.output)
        changed = pull.changed
      }
      const root = componentRoot(entry)
      return { changed, links: materialize(name, root, { enabled: enabledPlugins(entry, root) }) }
    })
    if (links.warnings.length) toast(api, "warning", links.warnings.join("\n"))
    const mutated = changed || links.outcomes.some((o) => ["created", "removed", "refreshed"].includes(o.state))
    toast(api, "success", `${name}: ${changed ? "updated to a new revision" : "already up to date"}${mutated ? ` — ${NOTICE}` : ""}`)
  } catch (err) {
    toast(api, "error", `${name}: update failed: ${message(err)}`)
  }
  back()
}

// back: the marketplace menu (a cancelled confirm returns there); a completed
// removal returns to the list beneath — the marketplace is gone
async function removeFlow(api, name, back) {
  const entry = readRegistry().marketplaces?.[name]
  if (!entry) {
    toast(api, "error", `marketplace "${name}" not found (ocm list)`)
    backView(api)
    return
  }
  const lines = [`remove marketplace "${name}"?`]
  for (const [plugin, record] of Object.entries(entry.plugins ?? {})) {
    if (!record.collision) lines.push(`  ${plugin} (${componentSummary(record)})`)
  }
  if (entry.local === false) lines.push(`the clone at ${entry.dir} is deleted`)
  if (!(await confirm(api, name, lines.join("\n")))) {
    back()
    return
  }
  try {
    const result = await withRegistryLock(`ocm remove ${name} (tui)`, () => removeMarketplace(name))
    if (result.warnings.length) toast(api, "warning", result.warnings.join("\n"))
    const restore = result.restore.length ? `${result.restore.join("\n")}\n` : ""
    toast(api, "success", `${restore}removed marketplace "${name}" — ${NOTICE}`)
  } catch (err) {
    toast(api, "error", message(err))
  }
  backView(api)
}

async function pinFlow(api, name, back) {
  const ref = await prompt(api, `Pin ${name}`, "Branch or tag to follow (empty to follow the default branch)")
  if (ref === null) {
    back()
    return
  }
  try {
    const result = await withRegistryLock(`ocm pin ${name} (tui)`, () => pinMarketplace(name, ref || null))
    toast(api, "success", `marketplace "${name}" ${result.cleared ? "unpinned" : `pinned to ${result.ref}`} — ${NOTICE}`)
  } catch (err) {
    toast(api, "error", message(err))
  }
  back()
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
    result = await withRegistryLock("ocm add (tui)", () => addMarketplace(source))
  } catch (err) {
    // a refused add still owes the user the diagnostics behind the refusal
    if (Array.isArray(err.warnings) && err.warnings.length) toast(api, "warning", err.warnings.join("\n"))
    alert(api, "ocm", `error: ${message(err)}`, back)
    return
  }
  if (result.warnings.length) toast(api, "warning", result.warnings.join("\n"))
  if (result.trustComponents.length && (await confirm(api, result.name, trustMessage(result.name, result.dir, result.trustComponents)))) {
    const second = await withRegistryLock(`ocm trust ${result.name} (tui)`, () => grantTrust(result.name))
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
