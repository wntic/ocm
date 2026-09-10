// The spec 12 finding format, shared by `ocm validate` and `ocm doctor`:
// two-space indent, severity padded to 8, then the message. The summary line
// appears only when something was found, and "fixed" never counts toward it —
// a fully repaired `doctor --fix` exits 0.
export interface Finding {
  severity: "error" | "warning" | "fixed"
  message: string
}

export function error(message: string): Finding {
  return { severity: "error", message }
}

export function warning(message: string): Finding {
  return { severity: "warning", message }
}

export function fixed(message: string): Finding {
  return { severity: "fixed", message }
}

// prints the findings and the summary; returns true when any error was found
export function reportFindings(findings: Finding[]): boolean {
  for (const finding of findings) {
    console.log(`  ${finding.severity.padEnd(8)}${finding.message}`)
  }
  const errors = findings.filter((finding) => finding.severity === "error").length
  const warnings = findings.filter((finding) => finding.severity === "warning").length
  if (errors + warnings > 0) {
    console.log(`${errors} ${errors === 1 ? "error" : "errors"}, ${warnings} ${warnings === 1 ? "warning" : "warnings"}`)
  }
  return errors > 0
}
