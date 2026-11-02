import type { Editor } from '@tiptap/core';

/**
 * Clear every cell's fixed column width so the table falls back to the
 * container width (`width: 100%` in editor.css). Tiptap's TableView removes
 * the inline `width: …px` and keeps only the min-width floor when no
 * `colwidth` remains.
 */
export function fitTableToWidth(editor: Editor, tablePos: number): boolean {
  if (editor.isDestroyed) return false;

  const { state } = editor;
  const table = state.doc.nodeAt(tablePos);
  if (!table || table.type.name !== 'table') return false;

  const tr = state.tr;
  let changed = false;
  table.descendants((node, offset) => {
    if (node.type.name !== 'tableCell' && node.type.name !== 'tableHeader') return true;
    if (node.attrs.colwidth == null) return false;
    tr.setNodeAttribute(tablePos + 1 + offset, 'colwidth', null);
    changed = true;
    return false;
  });

  if (!changed) return false;

  editor.view.dispatch(tr.scrollIntoView());
  return true;
}
