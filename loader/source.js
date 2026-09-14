import { existsSync, mkdirSync, realpathSync, renameSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { readManifest } from "./manifest.js"
import { HOME, MARKETPLACES_DIR } from "./paths.js"
import { git } from "./sync.js"

const GITHUB_TREE_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)(\/.*)?$/
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

export function isGitUrl(source) {
  return /^https?:|^git@|^file:\/\//.test(source)
}

// spec 17: ~/… is expanded by ocm itself (a shell-quoted tilde reaches us
// raw) and resolved against the cwd, so the registry never holds a relative
// path and links survive a cwd change
function expandPath(source) {
  const expanded = source.startsWith("~") ? join(HOME, source.replace(/^~\/?/, "")) : source
  return resolve(expanded)
}

function basename(p) {
  return p.replace(/\/+$/, "").split("/").pop() ?? p
}

export function normaliseMarketplaceName(name) {
  const normalised =
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "marketplace"
  // spec 17: the marketplace name limit, refused before any write
  if (normalised.length > 64) {
    throw new Error(`marketplace "${normalised}" exceeds 64 chars (${normalised.length})\n  add it again with --name <a shorter name>`)
  }
  return normalised
}

export function marketplaceNameFromUrl(url) {
  const cleaned = url
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .replace(/^https?:\/\/[^/]+\//, "")
    .replace(/^git@[^:]+:/, "")
  return normaliseMarketplaceName(cleaned.split("/").filter(Boolean).slice(-2).join("--"))
}

export function marketplaceDir(name) {
  return join(MARKETPLACES_DIR, name)
}

// spec 05 add step 1: git urls, github tree urls (repo + ref + subdir) and
// local paths (absolute, relative or ~/). Arguments are trimmed (spec 17).
export function parseSource(source) {
  source = source.trim()
  if (isGitUrl(source)) {
    const tree = source.match(GITHUB_TREE_RE)
    if (tree) {
      const url = `https://github.com/${tree[1]}/${tree[2]}`
      return {
        url,
        name: marketplaceNameFromUrl(url),
        subdir: tree[4] ? tree[4].replace(/^\/+|\/+$/g, "") : null,
        isGit: true,
        ref: tree[3],
      }
    }
    return { url: source, name: marketplaceNameFromUrl(source), subdir: null, isGit: true, ref: null }
  }
  const absolute = expandPath(source)
  if (!existsSync(absolute)) {
    // spec 17: a bare owner/repo is a common shorthand mistake — hint at the
    // full spellings rather than a bare not-found
    const shorthand = /^[\w.-]+\/[\w.-]+$/.test(source)
      ? `\n  looks like a repository shorthand — use git@github.com:${source}.git or https://github.com/${source}`
      : ""
    throw new Error(`path does not exist: ${source}${shorthand}`)
  }
  // realpath so a symlinked marketplace directory is stored post-resolution
  // and moving the link cannot orphan the install (spec 17)
  return { url: realpathSync(absolute), name: normaliseMarketplaceName(basename(absolute)), subdir: null, isGit: false, ref: null }
}

// a marketplace.json name is honoured only when it is already a valid
// marketplace name (spec 05 add step 2); an over-long one is ignored like an
// invalid one (spec 17)
export function manifestName(name) {
  return name && NAME_RE.test(name) && name.length <= 64 ? name : undefined
}

async function clone(url, dir, ref) {
  const args = ["clone", "--depth", "1"]
  if (ref) args.push("--branch", ref)
  args.push(url, dir)
  const result = await git(args)
  if (!result.ok) {
    throw new Error(`cannot access ${url} — the repository is private, unreachable, or the URL is wrong`)
  }
}

// clone under the url-derived name; a valid marketplace.json name renames
// the clone after the fact unless --name already decided it (spec 05 add
// step 2). The clone progress line is the CLI's — the core never prints.
export async function placeClone(parsed, name, ref, registry, named) {
  const dir = marketplaceDir(name)
  mkdirSync(MARKETPLACES_DIR, { recursive: true })
  try {
    await clone(parsed.url, dir, ref)
  } catch (err) {
    // a failed add leaves no clone behind (spec 05)
    rmSync(dir, { recursive: true, force: true })
    throw err
  }
  // spec 17: a fresh clone records its provenance immediately, so search
  // cannot call a just-added marketplace stale
  const head = (await git(["rev-parse", "HEAD"], dir)).stdout
  const declared = named ? undefined : manifestName(readManifest(parsed.subdir ? join(dir, parsed.subdir) : dir).name)
  if (!declared || declared === name) return { name, dir, head }
  if (registry.marketplaces[declared]) {
    rmSync(dir, { recursive: true, force: true })
    throw new Error(`marketplace "${declared}" already added (use "ocm update ${declared}")`)
  }
  renameSync(dir, marketplaceDir(declared))
  return { name: declared, dir: marketplaceDir(declared), head }
}
