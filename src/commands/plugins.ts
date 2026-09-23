import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { addRefusalChain, displayPath, isGitUrl, manifestName, parseSource, readManifest, readRegistry, resolvePlugin, setEnabled } from "../../loader/core.js"
import { OCM_LINKS_DIR, OPENCODE_AGENTS_DIR, OPENCODE_COMMANDS_DIR, OPENCODE_GLOBAL_CONFIG, OPENCODE_PLUGINS_DIR } from "../paths"
import { loadRegistry, loadRegistryForWrite, saveRegistry } from "../registry"
import { discoverMarketplace } from "../discovery"
import { clone, git, requireGit } from "../git"
import { reportMutationWarnings, reportRestart, reportUpgrade, reportWarnings, componentSummary, outcomeComponents } from "../report"

// spec 05 install: the core flips the record, saves and materializes; the
// CLI renders — disagreement first, then the upgrade, then the links report.
// spec 18: a takeover is stated as such; a no-op is not "installed" again.
// Brief 31 §6: the headline is derived from this plugin's outcomes — a
// displacement, a repair of hand-deleted links, or the plain summary.
// Brief 45 §3: a withheld component is not an install — partial first, and
// it implies !force, so it never co-occurs with a displacement or takeover
export function install(arg: string, force = false): void {
  const result = setEnabled(arg, true, { force })
  if (result.disagreement) reportWarnings([result.disagreement])
  reportUpgrade(result.wasV1)
  reportMutationWarnings(result.report, { marketplace: result.marketplace, plugin: result.plugin })
  const mine = result.report.outcomes.filter((o) => o.plugin === result.plugin)
  const withheld = mine.filter((o) => o.skip === "unowned-dest")
  const summary = componentSummary(outcomeComponents(mine))
  const created = mine.filter((o) => o.state === "created")
  const displaced = created.find((o) => o.displaced !== undefined)
  if (withheld.length > 0) {
    console.log(`installed ${result.plugin}@${result.marketplace} partially — ${withheld.length} component${withheld.length === 1 ? "" : "s"} withheld`)
    process.exitCode = 1
  } else if (result.takeover) {
    console.log(`took over "${result.plugin}" from marketplace "${result.takeover}"`)
  } else if (displaced) {
    console.log(`installed ${result.plugin}@${result.marketplace}${summary ? ` (${summary})` : ""}, displaced your ${displayPath(displaced.dest)} → ${displaced.displaced}`)
  } else if (result.already && created.length > 0) {
    console.log(`repaired ${created.length} link${created.length === 1 ? "" : "s"} for ${result.plugin}@${result.marketplace}`)
  } else if (result.already) console.log(`already installed ${result.plugin}@${result.marketplace}`)
  else console.log(`installed ${result.plugin}@${result.marketplace}${summary ? ` (${summary})` : ""}`)
  reportRestart(result.report)
}

export function uninstall(arg: string): void {
  const result = setEnabled(arg, false)
  reportUpgrade(result.wasV1)
  reportMutationWarnings(result.report, { marketplace: result.marketplace, plugin: result.plugin })
  // spec 23 §3: a no-op uninstall states it; §6: the headline precedes the
  // restart notice
  if (result.already) console.log(`${result.plugin}@${result.marketplace} not installed`)
  else console.log(`uninstalled ${result.plugin}@${result.marketplace}`)
  for (const line of result.restore) console.log(line)
  reportRestart(result.report)
}

export function setMode(name: string, mode: string): void {
  if (mode !== "auto" && mode !== "explicit") {
    throw new Error(`unknown mode "${mode}" (expected "auto" or "explicit")`)
  }
  const { registry, wasV1 } = loadRegistryForWrite()
  const entry = registry.marketplaces[name]
  if (!entry) throw new Error(`marketplace "${name}" not found (ocm list)`)
  entry.mode = mode
  saveRegistry(registry)
  reportUpgrade(wasV1)
  console.log(`marketplace "${name}" mode: ${mode}`)
}

// a plugin arg is a bare name or name@marketplace; anything with a url
// scheme or a slash is a source
function isPluginArg(source: string): boolean {
  if (isGitUrl(source) || source.includes("/")) return false
  return /^[a-z0-9]+(-[a-z0-9]+)*(@[a-z0-9]+(-[a-z0-9]+)*)?$/.test(source)
}

export async function scan(source: string): Promise<void> {
  if (isPluginArg(source) && !existsSync(source)) {
    scanPlugin(source)
    return
  }
  const parsed = parseSource(source)
  let dir = parsed.url
  let temp: string | null = null
  if (parsed.isGit) {
    requireGit()
    // scan never writes outside its temp directory (spec 05): the clone
    // lives in the os temp dir, not the marketplaces store
    temp = mkdtempSync(join(tmpdir(), "ocm-scan-"))
    console.log(`cloning ${parsed.url}...`)
    try {
      clone(parsed.url, temp, parsed.ref)
    } catch (err) {
      rmSync(temp, { recursive: true, force: true })
      throw err
    }
    dir = parsed.subdir ? join(temp, parsed.subdir) : temp
  }
  try {
    const discovered = discoverMarketplace(dir)
    reportWarnings(discovered.warnings)
    const plugins = [...discovered.plugins.values()]
    if (!plugins.length) {
      console.log(`no plugins found in ${source}`)
      console.log(`  expected plugins/<name>/{commands,agents,skills}/ at the repository root`)
      console.log(`  see ocm validate and the README's marketplace format`)
      return
    }
    // brief 29 §2 (F77): scan is a dry run of add — it runs add's refusal
    // chain, so its exit code predicts the real run's
    const name = manifestName(readManifest(dir).name) ?? parsed.name
    const head = temp ? git(["rev-parse", "HEAD"], temp).stdout : ""
    const refusal = await addRefusalChain(name, parsed, temp ?? dir, head, plugins, readRegistry())
    if (refusal) {
      const block = refusal.split("\n").map((line) => `  ${line}`).join("\n")
      throw new Error(`ocm add ${source} would be refused:\n${block}`)
    }
    console.log(`${plugins.length} plugin(s) would be installed from ${parsed.url}:`)
    for (const plugin of plugins) {
      console.log(`  ${plugin.name} (${componentSummary(plugin.components)})`)
    }
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true })
  }
}

// spec 18: every destination states its truth — nothing there is "would
// create", this plugin's symlink is "already linked", anything else is a
// named collision. Executables say "trust-gated" until the marketplace's
// code trust is granted: "would create" must not imply "would run"
function scanPlugin(arg: string): void {
  const { marketplace, plugin, entry } = resolvePlugin(loadRegistry(), arg)
  const record = entry.plugins[plugin]!
  const gated = entry.trust.code !== "granted"
  console.log(`installing ${plugin}@${marketplace} would materialize:`)
  for (const file of record.components.command ?? []) {
    scanDest(join(OPENCODE_COMMANDS_DIR, `${plugin}:${file}`), entry.dir)
  }
  for (const file of record.components.agent ?? []) {
    scanDest(join(OPENCODE_AGENTS_DIR, `${plugin}:${file}`), entry.dir)
  }
  for (const rel of record.components.skill ?? []) {
    const mirror = join(OCM_LINKS_DIR, marketplace, "skills", `${plugin}--${rel.split("/").join("-")}`)
    console.log(`  skill ${mirror}${existsSync(join(mirror, "SKILL.md")) ? " (already linked)" : " (would create)"}`)
  }
  for (const file of record.components.plugin ?? []) {
    scanDest(join(OPENCODE_PLUGINS_DIR, `ocm--${plugin}--${file}`), entry.dir, gated)
  }
  for (const server of record.components.mcp ?? []) {
    const key = `ocm--${plugin}--${server}`
    const state = mcpKeyPresent(key) ? "already linked" : `would create${gated ? ", trust-gated" : ""}`
    console.log(`  mcp ${key} in ${OPENCODE_GLOBAL_CONFIG} (${state})`)
  }
}

function scanDest(dest: string, marketplaceDir: string, gated = false): void {
  let stat
  try {
    stat = lstatSync(dest)
  } catch {}
  if (!stat) {
    console.log(`  ${dest} (would create${gated ? ", trust-gated" : ""})`)
    return
  }
  if (!stat.isSymbolicLink()) {
    console.log(`  ${dest} (collision: foreign file)`)
    return
  }
  const target = readlinkSync(dest)
  const owned = target === marketplaceDir || target.startsWith(`${marketplaceDir}/`)
  console.log(`  ${dest}${owned ? " (already linked)" : ` (collision: symlink → ${target})`}`)
}

function mcpKeyPresent(key: string): boolean {
  try {
    const config = JSON.parse(readFileSync(OPENCODE_GLOBAL_CONFIG, "utf8")) as { mcp?: Record<string, unknown> }
    return Boolean(config.mcp?.[key])
  } catch {
    return false
  }
}
