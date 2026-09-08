import { installLoader, migrateLegacyLayout, uninstallLoader } from "./loader"
import { add, remove, update, list, scan } from "./commands/marketplace"

const HELP = `ocm - file-based plugin marketplace for opencode

usage:
  ocm init                          install auto-sync loader
  ocm add <url|path>                add a marketplace (github url or local dir)
  ocm remove <name>                 remove a marketplace and its links
  ocm update [name]                 pull latest changes (all or one marketplace)
  ocm list                          list installed marketplaces and plugins
  ocm scan <url|path>               dry-run: show what would be installed
  ocm loader uninstall              remove auto-sync loader

examples:
  ocm add https://github.com/user/opencode-marketplace
  ocm add ~/plugins/my-marketplace
  ocm update`

export async function main(argv: string[]): Promise<void> {
  migrateLegacyLayout()
  const [command, ...rest] = argv

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
      requireArg(rest[0], "missing marketplace url or path")
      add(rest[0]!)
      break
    case "remove":
      requireArg(rest[0], "missing marketplace name")
      remove(rest[0]!)
      break
    case "update":
      await update(rest[0])
      break
    case "list":
      list()
      break
    case "scan":
      requireArg(rest[0], "missing marketplace url or path")
      scan(rest[0]!)
      break
    case "loader":
      if (rest[0] === "uninstall") {
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
