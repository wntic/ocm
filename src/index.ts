import { installLoader, migrateLegacyLayout, uninstallLoader } from "./loader"
import { migrateInstallation } from "./migrate"
import { add, pin, remove } from "./commands/marketplace"
import { update } from "./commands/update"
import { install, scan, setMode, uninstall } from "./commands/plugins"
import { trust, untrust } from "./commands/trust"
import { list } from "./commands/list"
import { search } from "./commands/search"
import { info } from "./commands/info"
import { validate } from "./commands/validate"
import { doctor } from "./commands/doctor"

const HELP = `ocm - file-based plugin marketplace for opencode

usage:
  ocm init                          install auto-sync loader
  ocm add <url|path> [--ref <ref>] [--explicit] [--name <name>] [--trust|--no-trust]
                                     add a marketplace (github url or local dir)
  ocm remove <name>                 remove a marketplace and its links
  ocm update [name|plugin@mp] [--quiet] [--json] [--trust|--no-trust]
                                     pull latest changes (all, one marketplace or one plugin's marketplace)
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
  ocm trust <name>                  approve a marketplace's executable components
  ocm untrust <name>                revoke trust and remove executable components
  ocm scan <url|path|plugin>        dry-run: show what would be installed
  ocm validate [path]               lint a marketplace repo (default: current directory)
  ocm doctor [--fix]                diagnose this installation; --fix applies safe fixes
  ocm loader uninstall              remove auto-sync loader

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

export async function main(argv: string[]): Promise<void> {
  migrateLegacyLayout()
  migrateInstallation()
  const [command, ...rest] = argv
  const { positional, flags, values } = parseArgs(rest)

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP)
      break
    case "init":
      installLoader()
      break
    case "add":
      requireArg(positional[0], "missing marketplace url or path")
      await add(positional[0]!, { explicit: flags.has("explicit"), name: values.name, ref: values.ref, trust: trustFlag(flags) })
      break
    case "remove":
      requireArg(positional[0], "missing marketplace name")
      remove(positional[0]!)
      break
    case "update":
      await update(positional[0], { quiet: flags.has("quiet"), json: flags.has("json"), trust: trustFlag(flags) })
      break
    case "pin":
      requireArg(positional[0], "missing marketplace name")
      await pin(positional[0]!, positional[1], flags.has("clear"))
      break
    case "list":
      list({ all: flags.has("all"), json: flags.has("json") })
      break
    case "search":
      requireArg(positional[0], "missing search query")
      search(positional[0]!, { enabledOnly: flags.has("enabled-only"), json: flags.has("json") })
      break
    case "info":
      requireArg(positional[0], "missing plugin name")
      info(positional[0]!, { json: flags.has("json") })
      break
    case "install":
    case "enable":
      requireArg(positional[0], "missing plugin name")
      install(positional[0]!, flags.has("force"))
      break
    case "uninstall":
    case "disable":
      requireArg(positional[0], "missing plugin name")
      uninstall(positional[0]!)
      break
    case "mode":
      requireArg(positional[0], "missing marketplace name")
      requireArg(positional[1], "missing mode (auto or explicit)")
      setMode(positional[0]!, positional[1]!)
      break
    case "trust":
      requireArg(positional[0], "missing marketplace name")
      await trust(positional[0]!)
      break
    case "untrust":
      requireArg(positional[0], "missing marketplace name")
      await untrust(positional[0]!)
      break
    case "scan":
      requireArg(positional[0], "missing url, path or plugin")
      scan(positional[0]!)
      break
    case "validate":
      validate(positional[0])
      break
    case "doctor":
      doctor(flags.has("fix"))
      break
    case "loader":
      if (positional[0] === "uninstall") {
        uninstallLoader()
      } else {
        throw new Error('unknown loader command, expected "ocm loader uninstall"')
      }
      break
    default:
      throw new Error(`unknown command "${command}" (ocm help)`)
  }
}

function requireArg(arg: string | undefined, message: string): void {
  if (!arg) throw new Error(message)
}
