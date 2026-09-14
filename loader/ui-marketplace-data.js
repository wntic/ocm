// The pure data shapes the marketplace views render from (spec 22 §4): list
// rows and detail lines, split from the flow module to keep it in budget.
export function marketplaceRows(registry) {
  return Object.entries(registry.marketplaces ?? {}).map(([name, entry]) => ({
    title: `${name} (${entry.mode}${entry.ref ? `, pinned @ ${entry.ref}` : ""})`,
    value: name,
    description: entry.local ? `${entry.url} (local)` : entry.url,
  }))
}

// spec 22 §4: the detail view states the pin and the current revision
export function marketplaceDetailLines(name, entry) {
  return [
    name,
    `url: ${entry.url}${entry.local ? " (local)" : ""}`,
    `mode: ${entry.mode}`,
    `pin: ${entry.ref ? `pinned @ ${entry.ref}` : "not pinned"}`,
    `revision: ${entry.revision ? entry.revision.slice(0, 7) : "unknown"}`,
    `plugins: ${Object.keys(entry.plugins ?? {}).length}`,
  ]
}
