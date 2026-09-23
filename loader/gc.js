import { rmSync } from "node:fs"
import { basename, join } from "node:path"
import { gcTargets, isRenderedFile } from "./links.js"
import { removedOutcome } from "./outcomes.js"
import { OPENCODE_AGENTS_DIR, OPENCODE_COMMANDS_DIR, OPENCODE_PLUGINS_DIR } from "./paths.js"

export function removeLegacyContainers(name) {
  rmSync(join(OPENCODE_COMMANDS_DIR, `ocm--${name}`), { recursive: true, force: true })
  rmSync(join(OPENCODE_AGENTS_DIR, `ocm--${name}`), { recursive: true, force: true })
}

// brief 41: a rendered command or agent is ours by its marker, but the
// commands and agents dirs are shared between marketplaces and the marker
// cannot say which one rendered it — the registry record claiming the
// plugin and the component is the scope, as a symlink's target is for links
export function renderedComponentOwned(entry, type) {
  return (path) => {
    if (!isRenderedFile(path)) return false
    const name = basename(path)
    const split = name.indexOf(":")
    const record = entry?.plugins?.[name.slice(0, split)]
    return Boolean(record && !record.collision && (record.components?.[type] ?? []).includes(name.slice(split + 1)))
  }
}

export function gcComponents(st) {
  // plugin names cannot contain ":", "--" or uppercase (PLUGIN_NAME_RE),
  // so a name prefix never spans another plugin's entries
  const scope = st.only === null ? undefined : `${st.only}:`
  const ownedCommand = renderedComponentOwned(st.entry, "command")
  const ownedAgent = renderedComponentOwned(st.entry, "agent")
  for (const entry of gcTargets(OPENCODE_COMMANDS_DIR, st.desiredCommands, st.ctx, ownedCommand, scope)) {
    const split = entry.indexOf(":")
    removedOutcome(st, "command", entry.slice(0, split), entry.slice(split + 1), join(OPENCODE_COMMANDS_DIR, entry))
  }
  for (const entry of gcTargets(OPENCODE_AGENTS_DIR, st.desiredAgents, st.ctx, ownedAgent, scope)) {
    const split = entry.indexOf(":")
    removedOutcome(st, "agent", entry.slice(0, split), entry.slice(split + 1), join(OPENCODE_AGENTS_DIR, entry))
  }
  for (const entry of gcTargets(st.skillsDir, st.desiredMirrors, st.ctx, (path) => isRenderedFile(join(path, "SKILL.md")), st.only === null ? undefined : `${st.only}--`)) {
    const split = entry.indexOf("--")
    removedOutcome(st, "skill", entry.slice(0, split), entry.slice(split + 2), join(st.skillsDir, entry))
  }
  for (const entry of gcTargets(OPENCODE_PLUGINS_DIR, st.desiredPluginLinks, st.ctx, undefined, st.only === null ? undefined : `ocm--${st.only}--`)) {
    const stripped = entry.slice("ocm--".length)
    const split = stripped.indexOf("--")
    removedOutcome(st, "plugin", stripped.slice(0, split), stripped.slice(split + 2), join(OPENCODE_PLUGINS_DIR, entry))
  }
}
