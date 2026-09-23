import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { errorMessage } from "./error-message.js"
import { OPENCODE_CONFIG_FILE, OPENCODE_DIR } from "./paths.js"
import { isRecord } from "./registry.js"

// brief 38 §2: the outcome says what this run did — "wrote" only when the
// config was actually written, so no caller can claim a fix it did not make
export function setSkillsPath(skillsDir, present) {
  let config = {}
  let raw
  try {
    raw = readFileSync(OPENCODE_CONFIG_FILE, "utf8")
  } catch {
    // a missing config reads as empty
  }
  if (raw !== undefined) {
    try {
      config = JSON.parse(raw)
    } catch {
      return { state: "skipped", reason: `skipped ${OPENCODE_CONFIG_FILE}: not valid JSON, left untouched` }
    }
  }
  if (!isRecord(config)) return { state: "skipped", reason: `skipped ${OPENCODE_CONFIG_FILE}: not a JSON object` }
  if (config.skills !== undefined && !isRecord(config.skills)) {
    return { state: "skipped", reason: `skipped ${OPENCODE_CONFIG_FILE}: "skills" is not an object` }
  }
  const skills = isRecord(config.skills) ? config.skills : {}
  if (skills.paths !== undefined && !Array.isArray(skills.paths)) {
    return { state: "skipped", reason: `skipped ${OPENCODE_CONFIG_FILE}: "skills.paths" is not an array` }
  }
  const paths = Array.isArray(skills.paths) ? skills.paths : []
  if (paths.includes(skillsDir) === present) return { state: "noop", reason: null }
  const next = present ? [...paths, skillsDir] : paths.filter((p) => p !== skillsDir)
  const updated = { ...config }
  if (present || next.length) {
    updated.skills = { ...skills, paths: next }
  } else if (Object.keys(skills).some((key) => key !== "paths")) {
    updated.skills = { ...skills }
    delete updated.skills.paths
  } else {
    delete updated.skills
  }
  try {
    mkdirSync(OPENCODE_DIR, { recursive: true })
    const tmp = `${OPENCODE_CONFIG_FILE}.tmp`
    writeFileSync(tmp, `${JSON.stringify(updated, null, 2)}\n`)
    renameSync(tmp, OPENCODE_CONFIG_FILE)
  } catch (err) {
    return { state: "failed", reason: `failed ${OPENCODE_CONFIG_FILE}: ${errorMessage(err)}` }
  }
  return { state: "wrote", reason: null }
}
