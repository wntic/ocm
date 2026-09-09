import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs"
import { join } from "node:path"
import { OCM_MARKETPLACES_DIR, marketplaceDir, marketplaceNameFromUrl, normaliseMarketplaceName } from "./paths"
import { clone } from "./git"
import { readManifest } from "./discovery"
import type { Registry } from "./types"

const GITHUB_TREE_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)(\/.*)?$/
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

export function isGitUrl(source: string): boolean {
  return /^https?:|^git@|^file:\/\//.test(source)
}

export function expandPath(source: string): string {
  return source.startsWith("~") ? join(process.env.HOME ?? "", source.replace(/^~\/?/, "")) : source
}

export interface ParsedSource {
  url: string
  name: string
  subdir: string | null
  isGit: boolean
  ref: string | null
}

function basename(p: string): string {
  return p.replace(/\/+$/, "").split("/").pop() ?? p
}

// spec 05 add step 1: git urls, github tree urls (repo + ref + subdir) and
// local paths (absolute, relative or ~/)
export function parseSource(source: string): ParsedSource {
  if (isGitUrl(source)) {
    const tree = source.match(GITHUB_TREE_RE)
    if (tree) {
      const url = `https://github.com/${tree[1]}/${tree[2]}`
      return {
        url,
        name: marketplaceNameFromUrl(url),
        subdir: tree[4] ? tree[4].replace(/^\/+|\/+$/g, "") : null,
        isGit: true,
        ref: tree[3]!,
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
export function manifestName(name: string | undefined): string | undefined {
  return name && NAME_RE.test(name) ? name : undefined
}

// clone under the url-derived name; a valid marketplace.json name renames
// the clone after the fact unless --name already decided it (spec 05 add
// step 2)
export function placeClone(
  parsed: ParsedSource,
  name: string,
  ref: string | null,
  registry: Registry,
  named: boolean,
): { name: string; dir: string } {
  const dir = marketplaceDir(name)
  mkdirSync(OCM_MARKETPLACES_DIR, { recursive: true })
  console.log(`cloning ${parsed.url}...`)
  clone(parsed.url, dir, ref)
  const declared = named ? undefined : manifestName(readManifest(parsed.subdir ? join(dir, parsed.subdir) : dir).name)
  if (!declared || declared === name) return { name, dir }
  if (registry.marketplaces[declared]) {
    rmSync(dir, { recursive: true, force: true })
    throw new Error(`marketplace "${declared}" already added (use "ocm update ${declared}")`)
  }
  renameSync(dir, marketplaceDir(declared))
  return { name: declared, dir: marketplaceDir(declared) }
}
