import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from 'prosemirror-model';

export type TableTextAlign = 'left' | 'center' | 'right';

const ALIGN_VALUES = new Set<string>(['left', 'center', 'right']);

function isTableCell(node: PMNode): boolean {
  return node.type.name === 'tableCell' || node.type.name === 'tableHeader';
}

function normalizeAlign(value: unknown): TableTextAlign | null {
  return typeof value === 'string' && ALIGN_VALUES.has(value)
    ? (value as TableTextAlign)
    : null;
}

/** The shared alignment of every cell, or null when the table is mixed/none. */
export function getTableTextAlign(table: PMNode): TableTextAlign | null {
  let align: TableTextAlign | null = null;
  let mixed = false;
  let first = true;

  table.descendants((node) => {
    if (!isTableCell(node)) return true;
    const value = normalizeAlign(node.attrs.align);
    if (first) {
      align = value;
      first = false;
    } else if (value !== align) {
      mixed = true;
    }
    return false;
  });

  return mixed ? null : align;
}

/** Apply one text alignment to every cell (header and body) of the table. */
export function setTableTextAlign(
  editor: Editor,
  tablePos: number,
  align: TableTextAlign,
): boolean {
  if (editor.isDestroyed) return false;

  const { state } = editor;
  const table = state.doc.nodeAt(tablePos);
  if (!table || table.type.name !== 'table') return false;

  const tr = state.tr;
  let changed = false;
  table.descendants((node, offset) => {
    if (!isTableCell(node)) return true;
    if (normalizeAlign(node.attrs.align) === align) return false;
    tr.setNodeAttribute(tablePos + 1 + offset, 'align', align);
    changed = true;
    return false;
  });

  if (!changed) return false;

  editor.view.dispatch(tr);
  return true;
}
