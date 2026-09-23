#!/usr/bin/env bun
import { errorMessage } from "../loader/core.js"
import { main } from "../src/index"

main(process.argv.slice(2)).catch((err) => {
  console.error(errorMessage(err))
  process.exit(1)
})
