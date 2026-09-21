// The /ocm TUI dialog entry (specs 10b, 22): registers the /ocm command and
// renders the menu screens. Every mutation is a core function the CLI also
// calls; the flows live in the ui-*.js siblings.
import { readRegistry, searchPlugins } from "./core.js"
import { componentSummary, pushView, select } from "./ui-dialog.js"
import { alert, prompt } from "./ui-modals.js"
import { blocked, openPlugin } from "./ui-plugins.js"
import { addMarketplaceFlow, openMarketplaces, runUpdateAll } from "./ui-marketplaces.js"

const EMPTY_STATE =
  "No marketplaces added yet.\n\nAdd one from your terminal:\n  ocm add <url|path>\n\nOr add one here."

// spec 22 §1: the empty state offers its own way in — the alert chains into
// the add flow, the only first-install route that stays inside opencode
export function emptyStateFlow(api, back) {
  alert(api, "ocm", EMPTY_STATE, () => addMarketplaceFlow(api, back))
}

export function openMainMenu(api) {
  const marketplaces = Object.entries(readRegistry().marketplaces ?? {})
  if (!marketplaces.length) {
    emptyStateFlow(api, () => openMainMenu(api))
    return
  }
  const plugins = marketplaces.reduce((count, [, entry]) => count + Object.keys(entry.plugins ?? {}).length, 0)
  select(api, {
    title: "ocm",
    options: [
      { title: "Browse plugins", value: "browse", description: `${plugins} plugins across ${marketplaces.length} marketplaces` },
      { title: "Search", value: "search", description: "Find a plugin by name, tag or command" },
      { title: "Marketplaces", value: "marketplaces", description: "Add, update, remove" },
      { title: "Update all", value: "update-all", description: "Pull every marketplace now" },
    ],
    onSelect: (option) => {
      if (option.value === "browse") openBrowse(api)
      else if (option.value === "search") searchFlow(api)
      else if (option.value === "marketplaces") openMarketplaces(api)
      else runUpdateAll(api)
    },
  })
}

function pluginOption(registry, marketplace, name, value) {
  const entry = registry.marketplaces[marketplace]
  const record = entry.plugins[name]
  const suffix = !record.enabled ? " (disabled)" : blocked(name, record, entry) ? " (blocked)" : ""
  return {
    title: `${name}@${marketplace}${suffix}`,
    value,
    description: record.manifest?.description || componentSummary(record),
    category: marketplace,
  }
}

// spec 22 §3: the list is a stack view — it remembers its selection when back
// returns to it, and the plugin menu is pushed on top of it
function openPluginList(api, title, items) {
  const state = { current: null }
  const render = () => {
    const registry = readRegistry()
    select(api, {
      title,
      current: state.current,
      options: items.map((item, i) => pluginOption(registry, item.marketplace, item.name, String(i))),
      onSelect: (option) => {
        state.current = option.value
        const item = items[Number(option.value)]
        if (item) pushView(api, () => openPlugin(api, item.marketplace, item.name))
      },
    })
  }
  pushView(api, render)
}

export function openBrowse(api) {
  const items = []
  for (const [marketplace, entry] of Object.entries(readRegistry().marketplaces ?? {})) {
    for (const name of Object.keys(entry.plugins ?? {})) items.push({ marketplace, name })
  }
  if (!items.length) {
    alert(api, "ocm", "No plugins found in any marketplace.", () => openMainMenu(api))
    return
  }
  openPluginList(api, "Browse plugins", items)
}

async function searchFlow(api) {
  const query = await prompt(api, "Search plugins", "Find a plugin by name, tag or command")
  if (!query) {
    openMainMenu(api)
    return
  }
  const matches = searchPlugins(query)
  if (!matches.length) {
    alert(api, "ocm", `No plugins match "${query}".`, () => openMainMenu(api))
    return
  }
  openPluginList(api, `Search: ${query}`, matches.map((m) => ({ marketplace: m.marketplace, name: m.plugin })))
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
          run: () => pushView(api, () => openMainMenu(api)),
        },
      ],
      bindings: [],
    })
    if (typeof unregister === "function" && typeof api.lifecycle?.onDispose === "function") {
      api.lifecycle.onDispose(unregister)
    }
  },
}
