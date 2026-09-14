// Shared view primitives for the /ocm TUI dialog (specs 10b, 22): thin
// wrappers over api.ui so every flow renders through the same dialogs, plus
// the pure wrap/size/scroll/stack models the views render from. Nothing
// reloads in-session, so every mutation toast ends with the restart notice.
const NOTICE = "restart opencode to activate"

// the widget library offers three fixed dialog widths; content is wrapped to
// the smallest one that fits both the content and the terminal (spec 22 §2)
const BUCKETS = [
  ["medium", 60],
  ["large", 88],
  ["xlarge", 116],
]

// measured: a select row inside a bucket frame holds 9 columns less than the
// frame — borders, padding and the selection gutter — so a medium row
// ellipsizes past 51 characters (spec 22 §2)
const ROW_CHROME = 9

const message = (err) => (err instanceof Error ? err.message : String(err))

function componentSummary(record) {
  const parts = []
  for (const [type, files] of Object.entries(record.components ?? {})) {
    if (files?.length) parts.push(`${files.length} ${type}${files.length === 1 ? "" : "s"}`)
  }
  return parts.join(", ") || "no components"
}

function terminalSize() {
  return { width: process.stdout.columns ?? 80, height: process.stdout.rows ?? 24 }
}

// spec 22 §2: greedy word wrap; a word longer than the width is broken across
// lines, never clipped
export function wrapText(text, width) {
  const lines = []
  for (const paragraph of String(text).split("\n")) {
    let line = ""
    const put = (piece) => {
      if (!line) line = piece
      else if (line.length + 1 + piece.length <= width) line += ` ${piece}`
      else {
        lines.push(line)
        line = piece
      }
    }
    for (const word of paragraph.split(" ").filter(Boolean)) {
      let rest = word
      while (rest.length > width) {
        put(rest.slice(0, width))
        rest = rest.slice(width)
      }
      put(rest)
    }
    lines.push(line)
  }
  return lines
}

// spec 22 §2: width = min(content need, terminal − 4) with a floor of 40;
// height = min(wrapped lines, terminal − 2)
export function dialogSize(lines, terminal) {
  const longest = lines.reduce((max, line) => Math.max(max, String(line).length), 0)
  const width = Math.max(40, Math.min(longest, terminal.width - 4))
  const wrapped = lines.flatMap((line) => wrapText(line, width))
  return { width, height: Math.min(wrapped.length, terminal.height - 2) }
}

// Wraps lines to the smallest bucket that fits them and the terminal; a body
// over the terminal's cap gets a viewport the caller scrolls. The widget
// clamps frame widths to terminal − 2, so a bucket wider than that renders
// clipped (spec 22 §2).
export function fit(lines) {
  const terminal = terminalSize()
  const need = dialogSize(lines, terminal)
  const bucket = BUCKETS.find(([, columns]) => need.width <= columns && columns <= terminal.width - 2) ?? BUCKETS[0]
  const frame = Math.min(bucket[1], terminal.width - 2)
  const wrapped = lines.flatMap((line) => wrapText(line, frame - ROW_CHROME))
  const cap = Math.max(1, terminal.height - Math.floor(terminal.height / 4) - 6)
  return { lines: wrapped, size: bucket[0], viewport: wrapped.length > cap ? createViewport(wrapped.length, cap) : null }
}

// spec 22 §2: the body scrolls under a fixed action row; the indicator names
// the first visible line ("3/17")
export function createViewport(total, visible) {
  const limit = Math.max(0, total - visible)
  let offset = 0
  return {
    get indicator() {
      return `${offset + 1}/${total}`
    },
    get slice() {
      return [offset, Math.min(offset + visible, total)]
    },
    key(name) {
      if (name === "down" || name === "j") offset = Math.min(offset + 1, limit)
      else if (name === "up" || name === "k") offset = Math.max(offset - 1, 0)
    },
  }
}

// spec 22 §3: the view-stack model behind back navigation — back() pops the
// current view and returns the one beneath, or null at the root (close)
export function createViewStack() {
  const stack = []
  return {
    push: (view) => stack.push(view),
    back() {
      stack.pop()
      return stack.length ? stack[stack.length - 1] : null
    },
  }
}

// spec 22 §3: the live view stack per api instance. A closed dialog means the
// old stack is stale — reopening /ocm starts over at the root.
const stacks = new WeakMap()

export function pushView(api, view) {
  let stack = stacks.get(api)
  if (!stack || api.ui.dialog?.open === false) {
    stack = createViewStack()
    stacks.set(api, stack)
  }
  stack.push(view)
  view()
}

export function backView(api) {
  const stack = stacks.get(api)
  if (!stack) return
  const previous = stack.back()
  // at the root the dialog is already closed by the Escape that got us here
  if (previous) previous()
}

export function select(api, props) {
  api.ui.dialog.replace(
    () => api.ui.DialogSelect(props),
    () =>
      queueMicrotask(() => {
        // Escape pops the dialog before the microtask runs; a forward
        // navigation has already replaced the stack with the next view
        if (api.ui.dialog.depth === 0) backView(api)
      }),
  )
  const lines = [
    ...String(props.title ?? "").split("\n"),
    ...(props.options ?? []).map((option) => `${option.title ?? ""} ${option.description ?? ""}`),
  ]
  api.ui.dialog.setSize(fit(lines).size)
}

export function toast(api, variant, text) {
  api.ui.toast({ variant, message: text })
}

export { NOTICE, componentSummary, message }
