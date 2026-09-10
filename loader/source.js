import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs"
import { join } from "node:path"
import { readManifest } from "./manifest.js"
import { HOME, MARKETPLACES_DIR } from "./paths.js"
import { git } from "./sync.js"

const GITHUB_TREE_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)(\/.*)?$/
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

export function isGitUrl(source) {
  return /^https?:|^git@|^file:\/\//.test(source)
}

function expandPath(source) {
  return source.startsWith("~") ? join(HOME, source.replace(/^~\/?/, "")) : source
}

function basename(p) {
  return p.replace(/\/+$/, "").split("/").pop() ?? p
}

export function normaliseMarketplaceName(name) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "marketplace"
  )
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
// local paths (absolute, relative or ~/)
export function parseSource(source) {
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
    throw new Error(`path does not exist: ${source}`)
  }
  return { url: absolute, name: normaliseMarketplaceName(basename(absolute)), subdir: null, isGit: false, ref: null }
}

// a marketplace.json name is honoured only when it is already a valid
// marketplace name (spec 05 add step 2)
export function manifestName(name) {
  return name && NAME_RE.test(name) ? name : undefined
}

async function clone(url, dir, ref) {
  const args = ["clone", "--depth", "1"]
  if (ref) args.push("--branch", ref)
  args.push(url, dir)
  const result = await git(args)
  if (!result.ok) {
    throw new Error(`git clone failed: ${result.stderr || result.stdout}`)
  }
}

// clone under the url-derived name; a valid marketplace.json name renames
// the clone after the fact unless --name already decided it (spec 05 add
// step 2). The clone progress line is the CLI's — the core never prints.
export async function placeClone(parsed, name, ref, registry, named) {
  const dir = marketplaceDir(name)
  mkdirSync(MARKETPLACES_DIR, { recursive: true })
  await clone(parsed.url, dir, ref)
  const declared = named ? undefined : manifestName(readManifest(parsed.subdir ? join(dir, parsed.subdir) : dir).name)
  if (!declared || declared === name) return { name, dir }
  if (registry.marketplaces[declared]) {
    rmSync(dir, { recursive: true, force: true })
    throw new Error(`marketplace "${declared}" already added (use "ocm update ${declared}")`)
  }
  renameSync(dir, marketplaceDir(declared))
  return { name: declared, dir: marketplaceDir(declared) }
}
