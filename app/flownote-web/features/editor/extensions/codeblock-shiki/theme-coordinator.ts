import type { EditorView } from '@tiptap/pm/view'

type ThemeChangeHandler = () => void

const handlersByEditor = new WeakMap<EditorView, Set<ThemeChangeHandler>>()

export function registerCodeBlockThemeHandler(
  view: EditorView,
  handler: ThemeChangeHandler,
): () => void {
  let handlers = handlersByEditor.get(view)
  if (!handlers) {
    handlers = new Set()
    handlersByEditor.set(view, handlers)
  }
  handlers.add(handler)

  return () => {
    handlers?.delete(handler)
    if (handlers?.size === 0) handlersByEditor.delete(view)
  }
}

export function notifyCodeBlockThemeChange(view: EditorView): void {
  for (const handler of handlersByEditor.get(view) ?? []) handler()
}
