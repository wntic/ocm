// Phase 02 — docs/specs/02-registry.md: one test per numbered item in its
// Tests section, plus the normalizeRegistry mirror in loader/core.js. The
// module under test runs in a spawned child under the fake $HOME; no probe —
// this spec changes no plugin files.
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { assertAbsent, withFakeHome } from "./harness.mjs"

const REGISTRY_MODULE = fileURLToPath(new URL("../src/registry.ts", import.meta.url))
const CORE_MODULE = fileURLToPath(new URL("../loader/core.js", import.meta.url))

// Applies [name, ...args] operations to a module in the child and prints the
// results as JSON; a thrown error is a non-zero exit with the message on
// stderr, which the atomicity test inspects.
const OPS_RUNNER = `
const [modulePath, ops] = process.argv.slice(2)
const mod = await import(modulePath)
const results = []
for (const [name, ...args] of JSON.parse(ops)) results.push(await mod[name](...args))
console.log(JSON.stringify(results))
`

function runOps(home, modulePath, ops) {
  const runner = join(home, "ops-runner.mjs")
  writeFileSync(runner, OPS_RUNNER)
  const result = spawnSync(process.execPath, [runner, modulePath, JSON.stringify(ops)], {
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  })
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

function runOpsOk(home, modulePath, ops) {
  const result = runOps(home, modulePath, ops)
  if (result.status !== 0) {
    throw new Error(`ops runner exited ${result.status} for ${modulePath}: ${result.stderr}`)
  }
  return JSON.parse(result.stdout)
}

function cfg(home) {
  return join(home, ".config", "opencode")
}

const registryFile = (home) => join(cfg(home), "ocm", "registry.json")
const legacyRegistryFile = (home) => join(cfg(home), "plugins", "ocm-registry.json")
const managedDir = (home, name) => join(home, ".cache", "ocm", "marketplaces", name)

function writeRegistry(path, registry) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(registry, null, 2)}\n`)
  return readFileSync(path, "utf8")
}

const ADDED_AT = "2026-09-01T10:00:00.000Z"

// v1 as stored today: top-level `path` duplicate of `url`, absolute sources.
function v1Registry(home) {
  const dir = managedDir(home, "example--mp")
  return {
    version: 1,
    marketplaces: {
      "example--mp": {
        url: "https://github.com/example/mp",
        path: "https://github.com/example/mp",
        dir, addedAt: ADDED_AT,
        plugins: {
          adw: {
            source: join(dir, "plugins", "adw"),
            components: { command: ["commit.md"], skill: ["code-review"] },
          },
        },
      },
    },
  }
}

// What the fixture above must read back as: every v2 default filled, `path`
// dropped, `source` marketplace-relative. Key order is the canonical save
// order (the spec's schema order) — test 3 byte-compares against it.
function v2FromV1(home) {
  return {
    version: 2,
    marketplaces: {
      "example--mp": {
        url: "https://github.com/example/mp",
        dir: managedDir(home, "example--mp"),
        local: false, addedAt: ADDED_AT, mode: "auto",
        ref: null, revision: null, syncIntervalMs: null,
        trust: { code: "none" }, lastSync: null,
        plugins: {
          adw: {
            source: "plugins/adw",
            components: { command: ["commit.md"], skill: ["code-review"] },
            enabled: true, installedAt: ADDED_AT, version: null, manifest: {},
          },
        },
      },
    },
  }
}

test("1. a v1 registry on disk reads back in v2 shape with defaults filled", async () => {
  await withFakeHome(async (home) => {
    const v1Bytes = writeRegistry(registryFile(home), v1Registry(home))
    const [loaded] = runOpsOk(home, REGISTRY_MODULE, [["loadRegistry"]])
    expect(loaded).toEqual(v2FromV1(home))
    // the old top-level duplicate of `url` is dropped, not carried over
    expect(loaded.marketplaces["example--mp"].path).toBeUndefined()
    // the v2 shape comes from normalization in memory, not from a rewrite
    expect(readFileSync(registryFile(home), "utf8")).toBe(v1Bytes)
  })
})

test("2. migration does not touch the file until an explicit save", async () => {
  await withFakeHome(async (home) => {
    const legacyBytes = writeRegistry(legacyRegistryFile(home), v1Registry(home))
    mkdirSync(join(cfg(home), "ocm"), { recursive: true })
    // invariants: config safety and ownership — user files survive ocm writes
    const userConfig = '{"model": "claude-sonnet-4-6", "permission": {"edit": "allow"}}\n'
    writeFileSync(join(cfg(home), "opencode.json"), userConfig)
    mkdirSync(join(cfg(home), "commands"), { recursive: true })
    writeFileSync(join(cfg(home), "commands", "commit.md"), "# user command\n")
    const [loaded] = runOpsOk(home, REGISTRY_MODULE, [["loadRegistry"]])
    // the legacy path is read as a fallback, never written; the v2 file
    // appears only on an explicit save
    expect(readFileSync(legacyRegistryFile(home), "utf8")).toBe(legacyBytes)
    assertAbsent(registryFile(home))
    runOpsOk(home, REGISTRY_MODULE, [["saveRegistry", loaded]])
    expect(JSON.parse(readFileSync(registryFile(home), "utf8"))).toEqual(v2FromV1(home))
    expect(readFileSync(legacyRegistryFile(home), "utf8")).toBe(legacyBytes)
    expect(readFileSync(join(cfg(home), "opencode.json"), "utf8")).toBe(userConfig)
    expect(readFileSync(join(cfg(home), "commands", "commit.md"), "utf8")).toBe("# user command\n")
  })
})

test("3. v2 round-trips byte-stably through load → save with no changes", async () => {
  await withFakeHome(async (home) => {
    // dir from another machine: v2 is passed through, so `local` must not be
    // re-derived against this machine's cache layout
    const v2 = v2FromV1(home)
    Object.assign(v2.marketplaces["example--mp"], {
      dir: "/home/someone-else/.cache/ocm/marketplaces/example--mp",
      mode: "explicit", ref: "v2.1.0", revision: "35eda0f9e2b1c3d4", syncIntervalMs: 3_600_000,
      trust: { code: "granted", grantedAt: ADDED_AT, fingerprint: "sha256:abc123" },
      lastSync: { at: "2026-09-08T09:00:00.000Z", ok: true, error: null },
    })
    Object.assign(v2.marketplaces["example--mp"].plugins.adw, {
      components: { command: ["commit.md"], agent: ["reviewer.md"], skill: ["code-review"], plugin: ["notify.js"], mcp: ["context7"] },
      enabled: false, installedAt: "2026-09-01T11:00:00.000Z", version: "1.2.0",
      manifest: { description: "review tools", category: "quality", tags: ["review"] },
    })
    const bytes = writeRegistry(registryFile(home), v2)
    const [loaded] = runOpsOk(home, REGISTRY_MODULE, [["loadRegistry"]])
    runOpsOk(home, REGISTRY_MODULE, [["saveRegistry", loaded]])
    expect(readFileSync(registryFile(home), "utf8")).toBe(bytes)
    // invariant: idempotence — saving the unchanged registry again is a no-op
    runOpsOk(home, REGISTRY_MODULE, [["saveRegistry", loaded]])
    expect(readFileSync(registryFile(home), "utf8")).toBe(bytes)
  })
})

test("4. unknown marketplace-level and plugin-level fields survive load → save", async () => {
  await withFakeHome(async (home) => {
    // also the registry half of the config-safety invariant
    const v2 = v2FromV1(home)
    v2.marketplaces["example--mp"].pinnedBy = "tui"
    v2.marketplaces["example--mp"].plugins.adw.futureFlag = { level: 3 }
    writeRegistry(registryFile(home), v2)
    const [loaded] = runOpsOk(home, REGISTRY_MODULE, [["loadRegistry"]])
    runOpsOk(home, REGISTRY_MODULE, [["saveRegistry", loaded]])
    const mp = JSON.parse(readFileSync(registryFile(home), "utf8")).marketplaces["example--mp"]
    expect(mp.pinnedBy).toBe("tui")
    expect(mp.plugins.adw.futureFlag).toEqual({ level: 3 })
    expect(mp.url).toBe("https://github.com/example/mp")
  })
})

test("5. absolute v1 sources are rewritten marketplace-relative and resolve back", async () => {
  await withFakeHome(async (home) => {
    const dir = managedDir(home, "example--mp")
    writeRegistry(registryFile(home), v1Registry(home))
    const [loaded] = runOpsOk(home, REGISTRY_MODULE, [["loadRegistry"]])
    const source = loaded.marketplaces["example--mp"].plugins.adw.source
    expect(source).toBe("plugins/adw")
    expect(join(dir, source)).toBe(join(dir, "plugins", "adw"))
  })
})

test("6. local is true for a marketplace dir under ~/.cache that ocm does not manage", async () => {
  await withFakeHome(async (home) => {
    const entry = (dir) => ({ url: "https://github.com/example/mp", dir, addedAt: ADDED_AT, plugins: {} })
    const v1 = {
      version: 1,
      marketplaces: {
        "managed--one": entry(managedDir(home, "managed--one")),
        "personal--mp": entry(join(home, ".cache", "personal", "personal--mp")),
      },
    }
    writeRegistry(registryFile(home), v1)
    const [loaded] = runOpsOk(home, REGISTRY_MODULE, [["loadRegistry"]])
    expect(loaded.marketplaces["managed--one"].local).toBe(false)
    expect(loaded.marketplaces["personal--mp"].local).toBe(true)
  })
})

test("7. a write into a read-only directory leaves the file intact and reports an actionable error", async () => {
  await withFakeHome(async (home) => {
    if (process.getuid?.() === 0) return console.log("skipped: root ignores directory permissions")
    const file = registryFile(home)
    const intact = writeRegistry(file, v2FromV1(home))
    const modified = v2FromV1(home)
    modified.marketplaces["example--mp"].revision = "deadbeef"
    const ocmDir = join(cfg(home), "ocm")
    chmodSync(ocmDir, 0o555)
    try {
      const result = runOps(home, REGISTRY_MODULE, [["saveRegistry", modified]])
      if (result.status === 0) {
        throw new Error(`expected saveRegistry to fail against read-only ${ocmDir}`)
      }
      // actionable: the error names the registry file it could not write
      expect(result.stderr).toContain(file)
      expect(readFileSync(file, "utf8")).toBe(intact)
      assertAbsent(join(ocmDir, "registry.json.tmp"))
    } finally {
      chmodSync(ocmDir, 0o755)
    }
  })
})

test("mirror: loader/core.js normalizes v1 and unknown versions like src/registry.ts", async () => {
  await withFakeHome(async (home) => {
    const v1 = v1Registry(home)
    for (const modulePath of [REGISTRY_MODULE, CORE_MODULE]) {
      const [fromV1, fromUnknown] = runOpsOk(home, modulePath, [
        ["normalizeRegistry", v1],
        ["normalizeRegistry", { version: 99, marketplaces: v1.marketplaces }],
      ])
      expect(fromV1).toEqual(v2FromV1(home))
      expect(fromUnknown).toEqual({ version: 2, marketplaces: {} })
    }
  })
})
