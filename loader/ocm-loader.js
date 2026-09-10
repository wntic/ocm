// namespace import, not named bindings: the loader must link even when
// core.js exports less than this file uses, so a partially updated core
// degrades the hook rather than the whole loader
import * as core from "../ocm/core.js"

export default {
  id: "ocm-loader",
  server: async () => {
    void core.syncAll({ reason: "startup" }).catch(() => {})
    return {
      // spec 11: command bodies reference ${OCM_PLUGIN_ROOT}/plugins/<name>/…
      // and Claude Code's ${CLAUDE_PLUGIN_ROOT}; both point at the
      // marketplace root
      "shell.env": async (_input, output) => {
        if (output && typeof output.env === "object" && output.env !== null) {
          Object.assign(output.env, core.pluginRootEnv())
        }
      },
    }
  },
}
