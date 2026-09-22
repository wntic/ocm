// A ReferenceError or TypeError is a defect in ocm, not a condition of the
// user's home. The loader's silent catches exist to keep opencode's startup
// alive through environmental failure (I/O, parse); swallowing a programming
// error with them once left the registry and the user's config silently
// disagreeing (brief 39 §5). Catches that run ocm logic re-throw these two;
// catches that guard a single environmental read keep swallowing everything.
export function rethrowIfDefect(err) {
  if (err instanceof ReferenceError || err instanceof TypeError) throw err
}
