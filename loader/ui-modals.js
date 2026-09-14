// The modal dialogs of the /ocm TUI (specs 10b, 22): alert, confirm and
// prompt. DialogAlert and DialogConfirm bodies are static text that cannot
// scroll, so a body taller than the terminal re-renders as a select with a
// scrolling window (spec 22 §2).
import { fit } from "./ui-dialog.js"

// spec 22 §2: the scrolling fallback — the action row leads, the windowed
// body follows, and the edge options page the viewport
function scrollingBody(api, title, fitted, actions, onPop) {
  const render = () => {
    const [from, to] = fitted.viewport.slice
    const options = [
      ...actions,
      ...(from > 0 ? [{ title: "↑ earlier lines", value: "scroll-up" }] : []),
      ...fitted.lines.slice(from, to).map((line, i) => ({ title: line, value: `line-${from + i}` })),
      ...(to < fitted.lines.length ? [{ title: `↓ more lines (${fitted.viewport.indicator})`, value: "scroll-down" }] : []),
    ]
    api.ui.dialog.replace(
      () =>
        api.ui.DialogSelect({
          title,
          skipFilter: true,
          options,
          onSelect: (option) => {
            if (option.value === "scroll-up" || option.value === "scroll-down") {
              const step = to - from
              for (let i = 0; i < step; i++) fitted.viewport.key(option.value === "scroll-down" ? "down" : "up")
              render()
              return
            }
            actions.find((action) => action.value === option.value)?.run()
          },
        }),
      onPop,
    )
    api.ui.dialog.setSize(fitted.size)
  }
  render()
}

export function alert(api, title, text, onConfirm) {
  const fitted = fit(String(text).split("\n"))
  if (fitted.viewport) {
    scrollingBody(api, title, fitted, [
      {
        title: "ok",
        value: "ok",
        run: () => {
          api.ui.dialog.clear()
          onConfirm?.()
        },
      },
    ])
    return
  }
  api.ui.dialog.replace(() =>
    api.ui.DialogAlert({
      title,
      message: fitted.lines.join("\n"),
      // DialogAlert clears the dialog right after onConfirm returns, wiping a
      // synchronous continuation — the F4 root cause, so the chain is deferred
      onConfirm: onConfirm && (() => queueMicrotask(onConfirm)),
    }),
  )
  api.ui.dialog.setSize(fitted.size)
}

export function confirm(api, title, text) {
  const fitted = fit(String(text).split("\n"))
  return new Promise((resolve) => {
    if (fitted.viewport) {
      scrollingBody(
        api,
        title,
        fitted,
        [
          { title: "confirm", value: "confirm", run: () => { api.ui.dialog.clear(); resolve(true) } },
          { title: "cancel", value: "cancel", run: () => { api.ui.dialog.clear(); resolve(false) } },
        ],
        // a scroll re-render replaces this dialog; only a real close (depth 0
        // once the microtask runs) answers false
        () => queueMicrotask(() => { if (api.ui.dialog.depth === 0) resolve(false) }),
      )
      return
    }
    api.ui.dialog.replace(
      () =>
        api.ui.DialogConfirm({
          title,
          message: fitted.lines.join("\n"),
          onConfirm: () => resolve(true),
          onCancel: () => resolve(false),
        }),
      () => resolve(false), // Escape pops the dialog without answering
    )
    api.ui.dialog.setSize(fitted.size)
  })
}

export function prompt(api, title, text) {
  return new Promise((resolve) => {
    let cleared = false
    const open = (value) => {
      api.ui.dialog.replace(
        () =>
          api.ui.DialogPrompt({
            title,
            placeholder: text,
            value,
            onConfirm: (input) => resolve(input),
          }),
        () =>
          queueMicrotask(() => {
            // spec 22 §3: the first Escape clears the input, the second backs
            // out; a forward navigation has already replaced the dialog
            if (api.ui.dialog.depth === 0) {
              if (cleared) resolve(null)
              else {
                cleared = true
                open("")
              }
            }
          }),
      )
    }
    open()
  })
}
