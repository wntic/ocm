import { existsSync } from "node:fs"
import { isGitRepo, pullRepo, readRegistry, refreshLinks, syncAll } from "./core.js"

function componentSummary(plugin) {
  const components = plugin?.components ?? {}
  const parts = []
  if (components.command?.length) parts.push(`${components.command.length} commands`)
  if (components.agent?.length) parts.push(`${components.agent.length} agents`)
  if (components.skill?.length) parts.push(`${components.skill.length} skills`)
  return parts.join(", ") || "no components"
}

function componentDetails(plugin) {
  const components = plugin?.components ?? {}
  const lines = []
  if (components.command?.length) lines.push(`commands: ${components.command.join(", ")}`)
  if (components.agent?.length) lines.push(`agents: ${components.agent.join(", ")}`)
  if (components.skill?.length) lines.push(`skills: ${components.skill.join(", ")}`)
  return lines.join("\n") || "no components"
}

function marketplaceEntries() {
  const registry = readRegistry()
  return Object.entries(registry.marketplaces ?? {}).filter(
    ([, entry]) => entry && typeof entry.dir === "string" && existsSync(entry.dir),
  )
}

function select(api, props) {
  api.ui.dialog.replace(() => api.ui.DialogSelect(props))
}

function alert(api, title, message) {
  api.ui.dialog.replace(() => api.ui.DialogAlert({ title, message, onConfirm: () => api.ui.dialog.clear() }))
}

function busy(api, message) {
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({ title: "ocm", options: [{ title: message, value: "busy", disabled: true }], onSelect: () => {} }),
  )
}

function toast(api, variant, message) {
  api.ui.toast({ variant, message })
}

function openMainMenu(api) {
  if (!marketplaceEntries().length) {
    alert(api, "ocm", "No marketplaces added yet.\n\nAdd one from your terminal:\n  ocm add <url|path>")
    return
  }
  select(api, {
    title: "ocm",
    options: [
      { title: "Browse plugins", value: "browse", description: "All plugins across marketplaces" },
      { title: "Update all", value: "update-all", description: "Pull every marketplace now" },
      { title: "Marketplaces", value: "marketplaces", description: "List and update marketplaces" },
    ],
    onSelect: (option) => {
      if (option.value === "browse") openBrowse(api)
      else if (option.value === "update-all") runUpdateAll(api)
      else if (option.value === "marketplaces") openMarketplaces(api)
    },
  })
}

function openBrowse(api) {
  const options = []
  const plugins = []
  for (const [marketplace, entry] of marketplaceEntries()) {
    for (const [name, plugin] of Object.entries(entry.plugins ?? {})) {
      const index = plugins.length
      plugins.push({ marketplace, name, plugin })
      options.push({
        title: `${name}@${marketplace}`,
        value: String(index),
        description: componentSummary(plugin),
        category: marketplace,
      })
    }
  }
  if (!options.length) {
    alert(api, "ocm", "No plugins found in any marketplace.")
    return
  }
  select(api, {
    title: "Browse plugins",
    placeholder: "Search plugins...",
    options,
    onSelect: (option) => {
      const found = plugins[Number(option.value)]
      if (found) openPlugin(api, found)
    },
  })
}

function openPlugin(api, { marketplace, name, plugin }) {
  select(api, {
    title: `${name}@${marketplace}`,
    options: [
      { title: "Details", value: "details", description: componentSummary(plugin) },
      { title: `Update ${marketplace}`, value: "update", description: "Pull latest changes for this marketplace" },
      { title: "Back", value: "back", description: "Back to the plugin list" },
    ],
    onSelect: (option) => {
      if (option.value === "details") {
        alert(
          api,
          `${name}@${marketplace}`,
          `${componentDetails(plugin)}\n\nsource: ${plugin?.source ?? `${marketplace}/plugins/${name}`}`,
        )
      } else if (option.value === "update") {
        updateMarketplace(api, marketplace, () => openPlugin(api, { marketplace, name, plugin }))
      } else {
        openBrowse(api)
      }
    },
  })
}

function openMarketplaces(api) {
  const entries = marketplaceEntries()
  select(api, {
    title: "Marketplaces",
    options: entries.map(([name, entry]) => ({
      title: name,
      value: name,
      description: entry.local ? `${entry.url} (local)` : entry.url,
    })),
    onSelect: (option) => {
      const name = option.value
      select(api, {
        title: name,
        options: [
          { title: "Update", value: "update", description: "Pull latest changes and refresh links" },
          { title: "Back", value: "back", description: "Back to the marketplace list" },
        ],
        onSelect: (inner) => {
          if (inner.value === "update") updateMarketplace(api, name, () => openMarketplaces(api))
          else openMarketplaces(api)
        },
      })
    },
  })
}

async function updateMarketplace(api, name, back) {
  const entry = readRegistry().marketplaces?.[name]
  if (!entry || typeof entry.dir !== "string" || !existsSync(entry.dir)) {
    toast(api, "error", `marketplace "${name}" not found`)
    back()
    return
  }
  busy(api, `Updating ${name}...`)
  try {
    let changed = false
    if (entry.local === false && isGitRepo(entry.dir)) {
      const pull = await pullRepo(entry.dir)
      if (!pull.ok) throw new Error(pull.output)
      changed = pull.changed
    }
    const links = refreshLinks(name, entry.dir)
    if (links.warnings.length) toast(api, "warning", links.warnings[0])
    toast(api, "success", `${name}: ${changed ? "updated to new revision" : "already up to date"}`)
  } catch (err) {
    toast(api, "error", `${name}: ${err instanceof Error ? err.message : String(err)}`)
  }
  back()
}

async function runUpdateAll(api) {
  busy(api, "Updating all marketplaces...")
  try {
    const result = await syncAll({ force: true })
    const lines = []
    if (result.updated?.length) lines.push(`updated: ${result.updated.join(", ")}`)
    else lines.push("all marketplaces up to date")
    if (result.failed?.length) lines.push(`failed: ${result.failed.join(", ")}`)
    if (result.warnings?.length) lines.push(`warnings: ${result.warnings.length}`)
    alert(api, "ocm", lines.join("\n"))
  } catch (err) {
    alert(api, "ocm", `Update failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export default {
  id: "ocm-ui",
  tui: async (api) => {
    const unregister = api.keymap?.registerLayer?.({
      commands: [
        {
          namespace: "palette",
          name: "ocm.open",
          title: "ocm marketplace",
          category: "ocm",
          slashName: "ocm",
          slash: { name: "ocm" },
          run: () => openMainMenu(api),
        },
      ],
      bindings: [],
    })
    if (typeof unregister === "function" && typeof api.lifecycle?.onDispose === "function") {
      api.lifecycle.onDispose(unregister)
    }
  },
}
