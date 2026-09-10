// Phase 01 — docs/specs/01-loader.md. One test per numbered item in its
// Tests section, then the edge cases, with the spec 00 invariants asserted
// where they apply (config safety, idempotence, ownership, no plugin errors).
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { expect, mock, test } from "bun:test"
import { assertAbsent, assertFileExists, opencodeProbe, withFakeHome } from "./harness.mjs"

// The installed set is the repository's loader/ directory, by definition
// (spec 01, "Installation set"): ocm-loader.js -> plugins/, every other
// *.js / *.d.ts -> ocm/. Derived, never enumerated, so a split of the core
// needs no amendment here — but a partial install or a stray still fails.
const LOADER_DIR = fileURLToPath(new URL("../loader", import.meta.url))
const LOADER_NAMES = readdirSync(LOADER_DIR).filter((name) => /\.(js|d\.ts)$/.test(name))
const INSTALLED = LOADER_NAMES.map((name) => (name === "ocm-loader.js" ? `plugins/${name}` : `ocm/${name}`))
const OCM_FILES = LOADER_NAMES.filter((name) => name !== "ocm-loader.js")

function cfg(home) {
  return join(home, ".config", "opencode")
}

function fileURL(path) {
  return pathToFileURL(path).href
}

function expectOk(result) {
  if (result.status !== 0) {
    throw new Error(`installLoader exited ${result.status}: ${result.stderr}`)
  }
  return result
}

function assertDirContains(dir, names) {
  const found = readdirSync(dir).sort()
  const expected = [...names].sort()
  if (found.join("\n") !== expected.join("\n")) {
    throw new Error(`expected exactly [${expected.join(", ")}] in ${dir}, found [${found.join(", ")}]`)
  }
}

test("1. installs exactly the repository's loader/ directory; plugins/ holds only ocm-loader.js", async () => {
  await withFakeHome(async (home, ocm) => {
    expectOk(await ocm.installLoader())
    const root = cfg(home)
    for (const file of INSTALLED) assertFileExists(join(root, file))
    assertDirContains(join(root, "plugins"), ["ocm-loader.js"])
    assertDirContains(join(root, "ocm"), OCM_FILES)
    // no stray files (e.g. leftover atomic-write temporaries) in the config dir
    assertDirContains(root, ["ocm", "plugins", "tui.json"])
  })
})

test("2. ocm-loader.js default-exports { id, server } with no setup; ocm/ui.js { id, tui } with no server", async () => {
  await withFakeHome(async (home, ocm) => {
    expectOk(await ocm.installLoader())
    const root = cfg(home)
    const loader = (await import(fileURL(join(root, "plugins/ocm-loader.js")))).default
    expect(typeof loader.id).toBe("string")
    expect(typeof loader.server).toBe("function")
    expect(loader.setup).toBeUndefined()
    const ui = (await import(fileURL(join(root, "ocm/ui.js")))).default
    expect(typeof ui.id).toBe("string")
    expect(typeof ui.tui).toBe("function")
    expect(ui.server).toBeUndefined()
  })
})

test("3. the installed ocm-loader.js imports ../ocm/core.js from its installed location", async () => {
  await withFakeHome(async (home, ocm) => {
    expectOk(await ocm.installLoader())
    const root = cfg(home)
    // rejects when the loader's relative import of its core is broken
    await import(fileURL(join(root, "plugins/ocm-loader.js")))
    const core = await import(fileURL(join(root, "ocm/core.js")))
    expect(typeof core.syncAll).toBe("function")
  })
})

test("4. server() resolves without awaiting the sync, and even when syncAll rejects", async () => {
  await withFakeHome(async (home, ocm) => {
    expectOk(await ocm.installLoader())
    const root = cfg(home)
    assertFileExists(join(root, "ocm/core.js"))
    const loaderURL = fileURL(join(root, "plugins/ocm-loader.js"))
    let rejectSync
    const sync = new Promise((_, reject) => {
      rejectSync = reject
    })
    mock.module(join(root, "ocm/core.js"), () => ({ syncAll: () => sync }))
    const loader = await import(`${loaderURL}?t=${Date.now()}`)

    let settled = false
    const firstCall = loader.default.server().then(() => {
      settled = true
    })
    // one event-loop turn lets a fire-and-forget server() settle; not a sleep
    await new Promise((resolve) => setImmediate(resolve))
    if (!settled) {
      throw new Error(`server() did not resolve while syncAll was still pending (${loaderURL})`)
    }
    await firstCall

    rejectSync(new Error("sync failed"))
    await new Promise((resolve) => setImmediate(resolve))
    await loader.default.server()
  })
})

test("5. tui.json keeps theme and keybinds; the ocm entry is added once and only once", async () => {
  await withFakeHome(async (home, ocm) => {
    const root = cfg(home)
    mkdirSync(root, { recursive: true })
    const tuiPath = join(root, "tui.json")
    const theme = { primary: "#ff0000" }
    const keybinds = { leader: "space" }
    const original = `${JSON.stringify({ theme, keybinds, plugin: ["./user-tui-plugin.js"] }, null, 2)}\n`
    writeFileSync(tuiPath, original)

    expectOk(await ocm.installLoader())
    const afterFirst = readFileSync(tuiPath, "utf8")
    const parsed = JSON.parse(afterFirst)
    expect(parsed.theme).toEqual(theme)
    expect(parsed.keybinds).toEqual(keybinds)
    const ocmEntries = parsed.plugin.filter((entry) => entry === "./ocm/ui.js")
    if (ocmEntries.length !== 1) {
      throw new Error(`expected exactly one "./ocm/ui.js" entry in ${tuiPath}, found ${ocmEntries.length}`)
    }
    expect(parsed.plugin).toContain("./user-tui-plugin.js")
    // outside the entry ocm owns, the file round-trips to the user's bytes
    const withoutOurs = { ...parsed, plugin: parsed.plugin.filter((entry) => entry !== "./ocm/ui.js") }
    expect(`${JSON.stringify(withoutOurs, null, 2)}\n`).toBe(original)

    // invariant: idempotence — the second run rewrites nothing
    const mtime = statSync(tuiPath).mtimeMs
    expectOk(await ocm.installLoader())
    expect(readFileSync(tuiPath, "utf8")).toBe(afterFirst)
    expect(statSync(tuiPath).mtimeMs).toBe(mtime)
  })
})

test("6. migration: the old layout ends in the new layout, registry preserved, tui entry rewritten", async () => {
  await withFakeHome(async (home, ocm) => {
    const root = cfg(home)
    const plugins = join(root, "plugins")
    mkdirSync(plugins, { recursive: true })
    const registry = {
      version: 1,
      marketplaces: {
        "mp--one": {
          url: "https://github.com/example/mp",
          dir: join(home, ".cache", "ocm", "marketplaces", "mp--one"),
          plugins: { adw: { source: "mp--one/plugins/adw", components: { command: ["commit.md"] } } },
        },
      },
    }
    const registryBytes = `${JSON.stringify(registry, null, 2)}\n`
    writeFileSync(join(plugins, "ocm-core.js"), "// old ocm core\n")
    writeFileSync(join(plugins, "ocm-ui.js"), "// old ocm ui\n")
    writeFileSync(join(plugins, "ocm-registry.json"), registryBytes)
    writeFileSync(join(root, "tui.json"), `${JSON.stringify({ plugin: ["./plugins/ocm-ui.js"] }, null, 2)}\n`)
    // invariant: ownership — files ocm does not own survive the migration
    writeFileSync(join(plugins, "user-plugin.js"), "// user plugin\n")
    mkdirSync(join(root, "commands"), { recursive: true })
    writeFileSync(join(root, "commands", "commit.md"), "# user command\n")

    const result = expectOk(await ocm.installLoader())
    for (const file of INSTALLED) assertFileExists(join(root, file))
    for (const file of ["ocm-core.js", "ocm-ui.js", "ocm-registry.json"]) {
      assertAbsent(join(plugins, file))
    }
    assertDirContains(plugins, ["ocm-loader.js", "user-plugin.js"])
    assertDirContains(join(root, "ocm"), [...OCM_FILES, "registry.json"])
    expect(readFileSync(join(root, "ocm", "registry.json"), "utf8")).toBe(registryBytes)
    expect(JSON.parse(readFileSync(join(root, "tui.json"), "utf8")).plugin).toEqual(["./ocm/ui.js"])
    expect(readFileSync(join(plugins, "user-plugin.js"), "utf8")).toBe("// user plugin\n")
    expect(readFileSync(join(root, "commands", "commit.md"), "utf8")).toBe("# user command\n")
    // spec migration step 5: "print one line naming what moved"
    expect(result.stdout).toMatch(/registry/)

    // invariant: idempotence — a second run changes nothing
    const snapshot = () => [
      readdirSync(plugins).sort(),
      readdirSync(join(root, "ocm")).sort(),
      readFileSync(join(root, "tui.json"), "utf8"),
      readFileSync(join(root, "ocm", "registry.json"), "utf8"),
    ]
    const before = snapshot()
    expectOk(await ocm.installLoader())
    expect(snapshot()).toEqual(before)
  })
})

test("7. opencode reports no plugin-load errors for ocm files", async () => {
  await withFakeHome(async (home, ocm) => {
    expectOk(await ocm.installLoader())
    const probe = opencodeProbe(cfg(home), home)
    if (!probe.available) {
      console.log("skipped: opencode is not on PATH")
      return
    }
    if (probe.unreliable) {
      throw new Error("probe cannot trust itself: the canary broken plugin produced no error line")
    }
    expect(probe.pluginErrors).toEqual([])
  })
  // two opencode runs (canary + probe), each with opencode 1.18.20's
  // plugin-loading stall — see the note in harness.mjs
}, 420_000)

test("edge: ocm/ exists but is not a directory — error naming the path, no partial install", async () => {
  await withFakeHome(async (home, ocm) => {
    const root = cfg(home)
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, "ocm"), "not a directory\n")
    const tuiBytes = '{"theme": "user"}\n'
    writeFileSync(join(root, "tui.json"), tuiBytes)

    const result = await ocm.installLoader()
    if (result.status === 0) {
      throw new Error(`expected installLoader to fail when ${join(root, "ocm")} is not a directory`)
    }
    expect(result.stderr).toContain(join(root, "ocm"))
    assertAbsent(join(root, "plugins", "ocm-loader.js"))
    expect(readFileSync(join(root, "tui.json"), "utf8")).toBe(tuiBytes)
  })
})

test("edge: tui.json plugin is not an array — warn, leave untouched, print the manual entry", async () => {
  await withFakeHome(async (home, ocm) => {
    const root = cfg(home)
    mkdirSync(root, { recursive: true })
    const tuiPath = join(root, "tui.json")
    const original = '{"theme": "user", "plugin": "not-an-array"}\n'
    writeFileSync(tuiPath, original)

    const result = expectOk(await ocm.installLoader())
    expect(readFileSync(tuiPath, "utf8")).toBe(original)
    expect(result.stderr).toContain("tui.json")
    expect(result.stderr).toContain("./ocm/ui.js")
  })
})

test("edge: unparseable tui.json — warn, leave untouched, print the manual entry", async () => {
  await withFakeHome(async (home, ocm) => {
    const root = cfg(home)
    mkdirSync(root, { recursive: true })
    const tuiPath = join(root, "tui.json")
    const original = "{ this is not json\n"
    writeFileSync(tuiPath, original)

    const result = expectOk(await ocm.installLoader())
    expect(readFileSync(tuiPath, "utf8")).toBe(original)
    expect(result.stderr).toContain("tui.json")
    expect(result.stderr).toContain("./ocm/ui.js")
  })
})
