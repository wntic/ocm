// brief 48 §3: which nothing-removed wording applies is a property of the
// tree, not the outcomes — a grant can outlive executable components an
// update uninstalled while the tree still ships them. brief 48 §4: one
// wording for the CLI headline and the TUI toast
export function untrustHeadline(name, removed, wasGranted, shipsNoExecutables) {
  if (removed) return `marketplace "${name}" no longer trusted; executable components removed`
  if (!wasGranted) return `marketplace "${name}" was not trusted; nothing changed`
  return shipsNoExecutables
    ? `marketplace "${name}" no longer trusted; it ships nothing executable, nothing was removed`
    : `marketplace "${name}" no longer trusted; none of its executable components were installed, nothing was removed`
}
