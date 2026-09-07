import { syncAll } from "./ocm-core.js"

function intervalMs() {
  const raw = parseInt(process.env.OCM_SYNC_INTERVAL_MS ?? "", 10)
  return Number.isFinite(raw) && raw >= 0 ? raw : 0
}

export default {
  id: "ocm-loader",
  setup: async (ctx) => {
    let result
    try {
      result = await syncAll({ minIntervalMs: intervalMs() })
    } catch {
      return {}
    }
    if (result.changed) {
      for (const reload of [ctx?.command?.reload, ctx?.agent?.reload]) {
        if (typeof reload === "function") {
          try {
            await reload()
          } catch {}
        }
      }
    }
    return {}
  },
}
