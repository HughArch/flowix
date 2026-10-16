import type { EditorView } from '@tiptap/pm/view';

/**
 * Acquire DOM focus before the browser's default mousedown focus can reveal
 * the editing host. The native pointer action still places/extends selection;
 * no Tiptap focus command or scroll-to-selection transaction is dispatched.
 */
export function focusEditorOnPointer(
  view: Pick<EditorView, 'dom' | 'editable' | 'hasFocus'>,
  event: MouseEvent,
): void {
  if (!view.editable || view.hasFocus() || event.defaultPrevented || event.button !== 0
    || event.altKey || event.ctrlKey || event.metaKey) return;
  const target = event.target;
  if (!(target instanceof Element) || !view.dom.contains(target)) return;
  // Property NodeViews, media controls, and nested Agent composers own their
  // focus independently, including their inputs and contenteditable roots.
  if (target.closest('[contenteditable]') !== view.dom
    || target.closest('input, textarea, select, button, a[href]')) return;
  view.dom.focus({ preventScroll: true });
}
