import { mcpTrustLine } from "../../loader/core.js"
import type { CoreExecutableComponent } from "../../loader/core.js"

// the listing every trust decision prints before asking: what runs, where it
// lives, and what it can do (spec 07). Data, so stdout; the question that
// follows is a prompt and goes to stderr
export function printTrustListing(name: string, dir: string, components: CoreExecutableComponent[]): void {
  console.log(`marketplace "${name}" ships code that opencode will execute:`)
  for (const component of components) {
    if (component.kind === "plugin") {
      console.log(`  plugin  ${component.plugin}/${component.name.replace(/\.[jt]s$/, "")} (${component.rel})`)
    } else {
      console.log(mcpTrustLine(component))
    }
  }
  console.log("this code runs with your shell's permissions on every opencode start.")
  console.log(`review it at ${dir}`)
}

// a one-shot SIGINT handler held for the duration of a prompt: on interrupt,
// say what stands on disk and exit 130 — never a silent 0 (spec 16)
function holdInterrupt(onInterrupt: () => void) {
  let fired = false
  const fire = () => {
    if (fired) return
    fired = true
    console.error("^C")
    onInterrupt()
    process.exit(130)
  }
  process.on("SIGINT", fire)
  return { fire, release: () => process.removeListener("SIGINT", fire) }
}

async function readAnswer(onSigint: () => void): Promise<string> {
  const { createInterface } = await import("node:readline/promises")
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    // raw mode swallows a typed ^C: route it to the same handler
    rl.on("SIGINT", onSigint)
    return (await rl.question("")).trim().toLowerCase()
  } finally {
    rl.close()
  }
}

// the prompt half of a trust decision: renders the block and reads the
// answer. The mutation is the caller's — the core never prompts (spec 10a)
export async function promptTrust(
  name: string,
  dir: string,
  components: CoreExecutableComponent[],
  onInterrupt: () => void,
): Promise<"granted" | "denied" | "skipped"> {
  const hold = holdInterrupt(onInterrupt)
  try {
    printTrustListing(name, dir, components)
    console.error("trust this marketplace to run code? [y/N/skip]")
    if (!process.stdin.isTTY) return "skipped"
    const answer = await readAnswer(hold.fire)
    if (answer === "y" || answer === "yes") return "granted"
    if (answer === "skip") return "skipped"
    return "denied"
  } finally {
    hold.release()
  }
}
