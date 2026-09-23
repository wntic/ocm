// Shared view primitives for the /ocm TUI dialog (specs 10b, 22): thin
// wrappers over api.ui so every flow renders through the same dialogs, plus
// the pure wrap/size/scroll/stack models the views render from. Nothing
// reloads in-session, so every mutation toast ends with the restart notice.
import { errorMessage as message } from "./error-message.js"

const NOTICE = "restart opencode to activate"

// the widget library offers three fixed dialog widths; the dialog takes the
// largest one that fits the terminal (brief 36 §4)
const BUCKETS = [
  ["medium", 60],
  ["large", 88],
  ["xlarge", 116],
]

// brief 36 §4: 12 is the brief's expected value, not a measurement — 9 is
// known wrong (rows ellipsized at 80×24 in the user's observed pass). The
// true value is confirmed only by the manual calibration checklist the human
// runs after this brief: sentinel rows exactly frame − ROW_CHROME characters
// wide, ending in "|", must show every sentinel in a real 80×24 terminal
// (opencode 1.18.31). Tests assert self-consistency against the constant,
// not its absolute truth.
const ROW_CHROME = 12

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
  // a terminal that reports zero columns makes every derived width negative,
  // and `rest.slice(0, -n)` is "" while `rest.slice(-n)` is the whole word —
  // the hard-break loop below then never terminates and opencode spins at
  // 100% CPU until it is killed. There is nothing sensible to wrap to here,
  // so hand the text back unwrapped.
  if (!(width > 0)) return String(text).split("\n")
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

// brief 36 §4: the largest bucket the terminal fits, never smaller — content
// need no longer shrinks the dialog
function largestBucket(width) {
  let bucket = BUCKETS[0]
  for (const entry of BUCKETS) if (entry[1] <= width - 2) bucket = entry
  return bucket
}

// Wraps lines to the largest bucket that fits the terminal; a body over the
// terminal's cap gets a viewport the caller scrolls. The widget clamps frame
// widths to terminal − 2, so a bucket wider than that renders clipped
// (brief 36 §4).
export function fit(lines) {
  const terminal = terminalSize()
  const bucket = largestBucket(terminal.width)
  // never below the chrome the rows themselves need (see wrapText)
  const frame = Math.max(ROW_CHROME + 1, Math.min(bucket[1], terminal.width - 2))
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

// brief 36 §4: the choke point every select dialog builds its wrapped props
// through — the bucket is the largest the terminal fits, and the title, every
// option title and every description is wrapped to its row budget. Pure: the
// terminal arrives as a plain { width, height }, never from process.stdout.
export function selectProps(props, terminal) {
  const bucket = largestBucket(terminal.width)
  const budget = Math.max(1, Math.min(bucket[1], terminal.width - 2) - ROW_CHROME)
  const options = []
  for (const option of props.options ?? []) {
    const titleLines = wrapText(option.title ?? "", budget)
    const descriptionLines = option.description === undefined ? null : wrapText(option.description, budget)
    const { description, ...rest } = option
    options.push(descriptionLines?.length === 1 ? { ...option, title: titleLines[0] } : { ...rest, title: titleLines[0] })
    for (const line of titleLines.slice(1)) options.push({ title: line, value: option.value })
    if (descriptionLines?.length > 1) {
      for (const line of descriptionLines) options.push({ title: line, value: option.value, disabled: true })
    }
  }
  return { props: { ...props, title: wrapText(props.title ?? "", budget).join("\n"), options }, size: bucket[0] }
}

export function select(api, props) {
  const built = selectProps(props, terminalSize())
  api.ui.dialog.replace(
    () => api.ui.DialogSelect(built.props),
    () =>
      queueMicrotask(() => {
        // Escape pops the dialog before the microtask runs; a forward
        // navigation has already replaced the stack with the next view
        if (api.ui.dialog.depth === 0) backView(api)
      }),
  )
  api.ui.dialog.setSize(built.size)
}

export function toast(api, variant, text) {
  api.ui.toast({ variant, message: text })
}

export { NOTICE, componentSummary, message }
