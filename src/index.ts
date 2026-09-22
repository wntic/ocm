import { accessSync, constants, existsSync } from "node:fs"
import { basename } from "node:path"
import { registryWriterVersion, versionCompare, withRegistryLock } from "../loader/core.js"
import { installLoader, loaderStatus, migrateLegacyLayout, packageVersion, reportTuiPlugin, uninstallLoader } from "./loader"
import { migrateInstallation, migrationNeeded } from "./migrate"
import { migrateLegacyCache, reportUnreferencedOldCache } from "./migrate-cache"
import { OCM_DIR, OPENCODE_GLOBAL_CONFIG, OPENCODE_TUI_CONFIG } from "./paths"
import { add, pin, remove } from "./commands/marketplace"
import { update } from "./commands/update"
import { install, scan, setMode, uninstall } from "./commands/plugins"
import { trust, untrust } from "./commands/trust"
import { list } from "./commands/list"
import { search } from "./commands/search"
import { info } from "./commands/info"
import { validate } from "./commands/validate"
import { doctor } from "./commands/doctor"
import { relativeXdgWarning, reportStrandedNotice } from "./stranded"
import { flushReportSink, markMutation } from "./report"

const HELP = `ocm - file-based plugin marketplace for opencode

usage:
  ocm add <url|path> [--ref <ref>] [--explicit] [--name <name>] [--trust|--no-trust]
                                     add a marketplace (github url or local dir)
  ocm init                          install auto-sync loader
  ocm remove <name>                 remove a marketplace and its links
  ocm update [marketplace] [--quiet] [--json] [--trust|--no-trust]
                                     pull latest changes (all or one marketplace)
  ocm pin <name> <ref>              follow a branch or tag
  ocm pin <name> --clear            back to the default branch
  ocm list [--all] [--json]         list marketplaces and plugins
  ocm search <query> [--enabled-only] [--json]
                                     search cached plugin metadata
  ocm info <plugin>[@<marketplace>] [--json]
                                     show a plugin's cached record
  ocm install <plugin>[@<mp>] [--force]
                                     enable a plugin and materialize its components
  ocm uninstall <plugin>[@<mp>]     disable a plugin and remove its links
  ocm enable <plugin>[@<mp>]        alias of install
  ocm disable <plugin>[@<mp>]       alias of uninstall
  ocm mode <name> <auto|explicit>   change when new upstream plugins install
  ocm trust <name> [--yes]          approve a marketplace's executable components
  ocm untrust <name>                revoke trust and remove executable components
  ocm scan <url|path|plugin>        dry-run: show what would be installed
  ocm validate [path]               lint a marketplace repo (default: current directory)
  ocm doctor [--fix]                diagnose this installation; --fix applies safe fixes
  ocm loader uninstall              remove auto-sync loader
  ocm --version                     print the version

examples:
  ocm add https://github.com/user/opencode-marketplace
  ocm add ~/plugins/my-marketplace
  ocm install commit-tools
  ocm update`

// flags that take a value: `--name foo` or `--name=foo`
const VALUE_FLAGS = new Set(["name", "ref"])

interface ParsedArgs {
  positional: string[]
  flags: Set<string>
  values: Record<string, string>
}

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = []
  const flags = new Set<string>()
  const values: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (!arg.startsWith("--")) {
      positional.push(arg)
      continue
    }
    const eq = arg.indexOf("=")
    if (eq !== -1) {
      values[arg.slice(2, eq)] = arg.slice(eq + 1)
    } else if (VALUE_FLAGS.has(arg.slice(2))) {
      values[arg.slice(2)] = args[++i] ?? ""
    } else {
      flags.add(arg.slice(2))
    }
  }
  return { positional, flags, values }
}

// `--trust` and `--no-trust` carry opposite decisions; absence means prompt
function trustFlag(flags: Set<string>): boolean | undefined {
  if (flags.has("trust")) return true
  if (flags.has("no-trust")) return false
  return undefined
}

// spec 20 F29: the atomic rename would silently bypass a read-only config —
// refuse the mutation before its first write instead
function preflightWritable(files: string[]): void {
  for (const file of files) {
    try {
      accessSync(file, constants.W_OK)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`error: ${basename(file)} is read-only — ocm will not bypass it\n  chmod +w ${file}, then re-run`)
    }
  }
}

// spec 27 §4: a home written by a newer ocm refuses the next downgrade
// before any write — forward-only, published pre-0.6 binaries have no guard
function refuseNewerHome(): void {
  const writer = registryWriterVersion()
  if (!writer) return
  const self = packageVersion()
  if (versionCompare(writer, self) <= 0) return
  throw new Error(
    `error: this installation was last written by ocm ${writer}; you are running ${self}\n` +
      "  upgrade with `npm i -g @wntic/ocm`, or run the newer ocm",
  )
}

// the §4 guard runs before the §1 lock: a refusal writes nothing, takes no
// lock, creates nothing
async function mutating<T>(command: string, fn: () => T | Promise<T>): Promise<T> {
  refuseNewerHome()
  // brief 38 §3 F186: a relative XDG_CONFIG_HOME is a write-boundary warning
  // — the mutation proceeds
  const relative = relativeXdgWarning()
  if (relative) console.error(`warning: ${relative}`)
  markMutation()
  return withRegistryLock(command, fn)
}

// An upgraded CLI left the installed loader behind: opencode kept running the
// previous version's modules at every start — with its config root and none of
// this version's fixes — until the user happened to run a mutating command.
// Refreshing is idempotent and belongs to ocm, so any command may do it; it
// writes, so it takes the lock, on the same detect-first rule migrations use.
// A home where the loader was never installed is left alone: that is `ocm
// init`'s job, not a side effect of running `ocm list`.
async function refreshStaleLoader(command: string | undefined): Promise<void> {
  if (command === undefined || command === "help" || command === "init") return
  const status = loaderStatus()
  if (!status.some((file) => file.state !== "missing")) return
  if (!status.some((file) => file.state !== "current")) return
  const previous = registryWriterVersion()
  await withRegistryLock(`ocm ${command}`, () => {
    installLoader(false, false)
    console.log(
      previous && previous !== packageVersion()
        ? `refreshed the auto-sync loader: ${previous} → ${packageVersion()} (restart opencode to activate)`
        : `refreshed the auto-sync loader to ${packageVersion()} (restart opencode to activate)`,
    )
  })
}

export async function main(argv: string[]): Promise<void> {
  try {
    const [command, ...rest] = argv
    const { positional, flags, values } = parseArgs(rest)
    // migrations run under the lock whatever command triggered them, including
    // a read-only one; an unneeded migration never touches the lock
    if (migrationNeeded()) {
      await withRegistryLock(command ? `ocm ${command}` : "ocm", () => {
        migrateLegacyLayout()
        migrateInstallation()
        migrateLegacyCache()
      })
    }
    reportUnreferencedOldCache()
    await refreshStaleLoader(command)

    switch (command) {
      case undefined:
      case "help":
      case "--help":
      case "-h":
        console.log(HELP)
        break
      case "--version":
      case "-v":
        console.log(packageVersion())
        break
      case "init":
        reportStrandedNotice()
        preflightWritable([OPENCODE_TUI_CONFIG])
        await mutating("ocm init", () => {
          if (installLoader()) reportTuiPlugin()
        })
        break
      case "add":
        reportStrandedNotice()
        requireArg(positional[0], "missing marketplace url or path")
        preflightWritable([OPENCODE_GLOBAL_CONFIG, OPENCODE_TUI_CONFIG])
        await mutating("ocm add", () =>
          add(positional[0]!, { explicit: flags.has("explicit"), name: values.name, ref: values.ref, trust: trustFlag(flags) }))
        break
      case "remove":
        requireArg(positional[0], "missing marketplace name")
        preflightWritable([OPENCODE_GLOBAL_CONFIG])
        await mutating("ocm remove", () => remove(positional[0]!))
        break
      case "update":
        reportStrandedNotice()
        preflightWritable([OPENCODE_GLOBAL_CONFIG, OPENCODE_TUI_CONFIG])
        await mutating("ocm update", () =>
          update(positional[0], { quiet: flags.has("quiet"), json: flags.has("json"), trust: trustFlag(flags) }))
        break
      case "pin":
        requireArg(positional[0], "missing marketplace name")
        await mutating("ocm pin", () => pin(positional[0]!, positional[1], flags.has("clear")))
        break
      case "list":
        list({ all: flags.has("all"), json: flags.has("json"), stranded: reportStrandedNotice() })
        break
      case "search":
        reportStrandedNotice()
        requireArg(positional[0], "missing search query")
        search(positional[0]!, { enabledOnly: flags.has("enabled-only"), json: flags.has("json") })
        break
      case "info":
        reportStrandedNotice()
        requireArg(positional[0], "missing plugin name")
        info(positional[0]!, { json: flags.has("json") })
        break
      case "install":
      case "enable":
        reportStrandedNotice()
        requireArg(positional[0], "missing plugin name")
        preflightWritable([OPENCODE_GLOBAL_CONFIG])
        await mutating(`ocm ${command}`, () => install(positional[0]!, flags.has("force")))
        break
      case "uninstall":
      case "disable":
        requireArg(positional[0], "missing plugin name")
        preflightWritable([OPENCODE_GLOBAL_CONFIG])
        await mutating(`ocm ${command}`, () => uninstall(positional[0]!))
        break
      case "mode":
        requireArg(positional[0], "missing marketplace name")
        requireArg(positional[1], "missing mode (auto or explicit)")
        await mutating("ocm mode", () => setMode(positional[0]!, positional[1]!))
        break
      case "trust":
        reportStrandedNotice()
        requireArg(positional[0], "missing marketplace name")
        preflightWritable([OPENCODE_GLOBAL_CONFIG])
        await mutating("ocm trust", () => trust(positional[0]!, flags.has("yes")))
        break
      case "untrust":
        requireArg(positional[0], "missing marketplace name")
        preflightWritable([OPENCODE_GLOBAL_CONFIG])
        await mutating("ocm untrust", () => untrust(positional[0]!))
        break
      case "scan":
        requireArg(positional[0], "missing url, path or plugin")
        await scan(positional[0]!)
        break
      case "validate":
        validate(positional[0])
        break
      case "doctor": {
        const fix = flags.has("fix")
        if (fix) preflightWritable([OPENCODE_GLOBAL_CONFIG, OPENCODE_TUI_CONFIG])
        // the not-installed refusal happens inside doctor() before any write —
        // the lock is taken only once the home exists
        if (fix && existsSync(OCM_DIR)) await mutating("ocm doctor --fix", () => doctor(true))
        else doctor(fix)
        break
      }
      case "loader":
        if (positional[0] === "uninstall") {
          preflightWritable([OPENCODE_TUI_CONFIG])
          await mutating("ocm loader uninstall", () => uninstallLoader())
        } else {
          throw new Error('unknown loader command, expected "ocm loader uninstall"')
        }
        break
      default:
        throw new Error(`unknown command "${command}" (ocm help)`)
    }
  } finally {
    // brief 31 §7: the sink flushes on the error path too, before bin/ocm.ts
    // prints the error
    flushReportSink()
  }
}

function requireArg(arg: string | undefined, message: string): void {
  if (!arg) throw new Error(message)
}
