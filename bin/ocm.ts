#!/usr/bin/env bun
import { main } from "../src/index"

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
