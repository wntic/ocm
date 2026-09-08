import { syncAll } from "../ocm/core.js"

export default {
  id: "ocm-loader",
  server: async () => {
    void syncAll({ reason: "startup" }).catch(() => {})
    return {}
  },
}
