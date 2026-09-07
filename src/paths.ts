import { homedir } from "node:os"
import { join } from "node:path"

export const HOME = homedir()

export const OPENCODE_GLOBAL_DIR = join(HOME, ".config", "opencode")
export const OPENCODE_GLOBAL_CONFIG = join(OPENCODE_GLOBAL_DIR, "opencode.json")

export const OCM_CACHE_DIR = join(HOME, ".cache", "ocm")
export const OCM_MARKETPLACES_DIR = join(OCM_CACHE_DIR, "marketplaces")
export const OCM_LINKS_DIR = join(OCM_CACHE_DIR, "links")

export const OCM_REGISTRY_DIR = join(OPENCODE_GLOBAL_DIR, "plugins")
export const OCM_REGISTRY_FILE = join(OCM_REGISTRY_DIR, "ocm-registry.json")

export const OCM_LOADER_NAME = "ocm-loader.js"
export const OCM_LOADER_TARGET = join(OPENCODE_GLOBAL_DIR, "plugins", OCM_LOADER_NAME)

export function marketplaceDir(name: string): string {
  return join(OCM_MARKETPLACES_DIR, name)
}

export function marketplaceNameFromUrl(url: string): string {
  const cleaned = url
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .replace(/^https?:\/\/[^/]+\//, "")
    .replace(/^git@[^:]+:/, "")
  return (
    cleaned
      .split("/")
      .filter(Boolean)
      .slice(-2)
      .join("--")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "marketplace"
  )
}
