#!/bin/sh
":" //; command -v bun >/dev/null 2>&1 || { echo "error: ocm needs Bun, which is not on PATH" >&2; echo "  install it from https://bun.com, then re-run" >&2; exit 1; }; exec bun "$0" "$@"
import { errorMessage } from "../loader/core.js"
import { main } from "../src/index"

main(process.argv.slice(2)).catch((err) => {
  console.error(errorMessage(err))
  process.exit(1)
})
