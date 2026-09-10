import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { OPENCODE_CONFIG_FILE, OPENCODE_DIR } from "./paths.js"
import { isRecord } from "./registry.js"

export function setSkillsPath(skillsDir, present) {
  let config = {}
  let raw
  try {
    raw = readFileSync(OPENCODE_CONFIG_FILE, "utf8")
  } catch {}
  if (raw !== undefined) {
    try {
      config = JSON.parse(raw)
    } catch {
      return `skipped ${OPENCODE_CONFIG_FILE}: not valid JSON, left untouched`
    }
  }
  if (!isRecord(config)) return `skipped ${OPENCODE_CONFIG_FILE}: not a JSON object`
  if (config.skills !== undefined && !isRecord(config.skills)) {
    return `skipped ${OPENCODE_CONFIG_FILE}: "skills" is not an object`
  }
  const skills = isRecord(config.skills) ? config.skills : {}
  if (skills.paths !== undefined && !Array.isArray(skills.paths)) {
    return `skipped ${OPENCODE_CONFIG_FILE}: "skills.paths" is not an array`
  }
  const paths = Array.isArray(skills.paths) ? skills.paths : []
  if (paths.includes(skillsDir) === present) return null
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
    return `failed ${OPENCODE_CONFIG_FILE}: ${err instanceof Error ? err.message : String(err)}`
  }
  return null
}
