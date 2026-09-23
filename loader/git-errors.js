import { existsSync } from "node:fs"
import { basename } from "node:path"
import { fileURLToPath } from "node:url"
import { isGitRepo } from "./git.js"

// brief 32 §1: git exits 128 for almost every failure, so the exit code
// classifies nothing — stderr plus facts ocm already holds do. Matching is
// case-insensitive substring, never an exact-line compare.

function localPath(url) {
  if (!url.startsWith("file://")) return null
  try {
    return fileURLToPath(url)
  } catch {
    return null
  }
}

function nonEmptyLines(raw) {
  return raw.split("\n").map((line) => line.trim()).filter(Boolean)
}

function accessSentence(c) {
  return `cannot access ${c.url}${c.ref ? ` (ref "${c.ref}")` : ""} — the repository is private, unreachable, or the URL is wrong`
}

const any = (stderr, needles) => needles.some((needle) => stderr.includes(needle))

// [code, recogniser, message]; first match wins
const TABLE = [
  // node and bun word a missing binary differently, so both the spawn
  // error's code and each runtime's stderr text are recognised
  ["git-missing", (c) => c.error?.code === "ENOENT" || c.stderr.includes("spawn git enoent") || c.stderr.includes('executable not found in $path: "git"'),
    () => "git is not on PATH — ocm needs git to clone and update marketplaces\n  install git, then re-run"],
  ["local-not-a-repo", (c) => c.stderr.includes("does not appear to be a git repository"),
    (c) => `${c.path ?? c.url} is a directory, not a git repository\n  add a local directory by path: ocm add ${c.path ?? c.url}`],
  ["ref-missing", (c) => any(c.stderr, ["couldn't find remote ref", "not found in upstream"]),
    (c) => `${c.url} has no ref "${c.ref ?? "HEAD"}" — it may have been deleted or renamed upstream\n  ocm pin ${c.mp} ${c.ref ?? "HEAD"} to follow another, or ocm pin ${c.mp} to follow the default branch`],
  ["stale-lock", (c) => any(c.stderr, ["cannot lock ref", ".lock': file exists", "index.lock", "shallow.lock"]),
    (c) => `${c.dir} holds a git lock left by an interrupted git process (${c.lock})\n  remove that file, then re-run`],
  ["clone-target-exists", (c) => c.stderr.includes("already exists and is not an empty directory"),
    (c) => `${c.dir} already exists and is not an empty directory\n  remove it, then re-run`],
  ["network",
    (c) => any(c.stderr, ["could not resolve host", "connection timed out", "failed to connect"]) ||
      (c.stderr.includes("unable to access") && (c.stderr.includes("ssl") || c.stderr.includes("tls"))),
    (c) => `cannot reach ${c.url} — ${c.lines[0]}`],
  ["timed-out", (c) => c.stderr.includes("git timed out"),
    (c) => `git timed out after 120s on ${c.url}`],
  ["auth-or-missing",
    (c) => any(c.stderr, ["authentication failed", "could not read username", "terminal prompts disabled", "repository not found", "permission denied (publickey)", "support for password authentication"]),
    accessSentence],
]

export function classifyGitFailure({ result, url, ref, dir }) {
  const raw = typeof result?.stderr === "string" ? result.stderr : ""
  // a file:// url's local facts are classified from the url alone, before
  // stderr is read — the clone path refuses without spawning git
  const path = localPath(url)
  if (path !== null) {
    if (!existsSync(path)) return { code: "local-missing", message: `${path} does not exist` }
    if (!isGitRepo(path)) {
      return { code: "local-not-a-repo", message: `${path} is a directory, not a git repository\n  add a local directory by path: ocm add ${path}` }
    }
  }
  const c = {
    stderr: raw.toLowerCase(), url, dir, path,
    error: result?.error,
    ref: ref ?? null,
    mp: basename(dir),
    lock: raw.match(/[^'\s]+\.lock/)?.[0] ?? "a git lock file",
    lines: nonEmptyLines(raw),
  }
  for (const [code, recogniser, message] of TABLE) {
    if (recogniser(c)) return { code, message: message(c) }
  }
  // the fallback rule: the same sentence, with git's own words appended
  return { code: "unknown", message: accessSentence(c) + c.lines.slice(0, 2).map((line) => `\n  git: ${line}`).join("") }
}
