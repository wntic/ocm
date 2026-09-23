import { readFileSync, readlinkSync, rmSync } from "node:fs"
import { isRenderedFile, isRenderedFrom, render } from "./links.js"

// the single transform: `name: <value>` becomes `name: "<plugin>:<value>"`;
// everything else in the file is preserved byte-for-byte
export function renderSkillMd(content, plugin) {
  if (!content.startsWith("---\n")) return null
  const close = content.indexOf("\n---\n", 3)
  if (close === -1) return null
  const frontmatter = content.slice(4, close)
  const match = frontmatter.match(/^name:[^\n]*/m)
  if (!match) return null
  const value = match[0].slice(5).trim().replace(/^["']|["']$/g, "")
  if (!value) return null
  const renamed = `name: "${plugin}:${value}"`
  const updated = frontmatter.slice(0, match.index) + renamed + frontmatter.slice(match.index + match[0].length)
  return content.slice(0, 4) + updated + content.slice(close)
}

// brief 41: a body referencing a plugin-root variable renders with this
// marketplace's root substituted — the variable never reaches opencode's
// template engine, so a symlink would be broken exactly where it is used.
// Returns null when the body has no token, so the caller keeps link().
export function renderRooted(st, source, dest, plugin) {
  let body
  try {
    body = readFileSync(source, "utf8")
  } catch {
    // an unreadable body means no rooted render — the caller links instead
  }
  if (!body || !st.rootTokens.some((token) => body.includes(token))) return null
  let existing
  try {
    existing = readlinkSync(dest)
  } catch {
    // not a symlink — no symlink→rendered transition to make
  }
  // the symlink→rendered transition: dest is unambiguously ours by the
  // same proof link() uses for "ok", so remove it — render() would
  // otherwise displace it as unowned
  if (existing === source) rmSync(dest, { force: true })
  const owned = isRenderedFile(dest)
  let text = body
  for (const token of st.rootTokens) text = text.replaceAll(token, st.dir)
  const status = render(source, dest, () => text, st.ctx, plugin)
  // an update to an existing rendered file is a refresh (current or
  // refreshed via the changed set), never a creation
  return status === "created" && owned ? "ok" : status
}

// the rendered→symlink transition, the mirror of the one above: an author
// who drops the variable from a body leaves a rendered file where a symlink
// now belongs. link() proves ownership by "is a symlink into a managed
// dir", so it would call ocm's own artifact unmanaged — skipping it forever
// without --force, and with --force moving it into the displaced cache as
// though it were the user's hand-written file. The marker naming this exact
// source is the proof, so no other marketplace's file can match.
export function clearRendered(dest, source, dir) {
  if (isRenderedFrom(dest, source, dir)) rmSync(dest, { force: true })
}
