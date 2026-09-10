// Shared view primitives for the /ocm TUI dialog (spec 10b): thin wrappers
// over api.ui so every flow renders through the same dialogs. Nothing
// reloads in-session, so every mutation toast ends with the restart notice.
const NOTICE = "restart opencode to activate"

const message = (err) => (err instanceof Error ? err.message : String(err))

function componentSummary(record) {
  const parts = []
  for (const [type, files] of Object.entries(record.components ?? {})) {
    if (files?.length) parts.push(`${files.length} ${type}${files.length === 1 ? "" : "s"}`)
  }
  return parts.join(", ") || "no components"
}

export function select(api, props) {
  api.ui.dialog.replace(() => api.ui.DialogSelect(props))
}

export function alert(api, title, text, onConfirm) {
  api.ui.dialog.replace(() =>
    api.ui.DialogAlert({ title, message: text, onConfirm: () => (onConfirm ? onConfirm() : api.ui.dialog.clear()) }),
  )
}

export function confirm(api, title, text) {
  return new Promise((resolve) => {
    api.ui.dialog.replace(() =>
      api.ui.DialogConfirm({ title, message: text, onConfirm: () => resolve(true), onCancel: () => resolve(false) }),
    )
  })
}

export function prompt(api, title, text) {
  return new Promise((resolve) => {
    api.ui.dialog.replace(() =>
      api.ui.DialogPrompt({ title, message: text, onConfirm: (value) => resolve(value), onCancel: () => resolve(null) }),
    )
  })
}

export function toast(api, variant, text) {
  api.ui.toast({ variant, message: text })
}

export { NOTICE, componentSummary, message }
