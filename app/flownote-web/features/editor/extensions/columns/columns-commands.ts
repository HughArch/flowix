import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from 'prosemirror-model';
import {
  COLUMN_WIDTH_UNIT,
  MAX_COLUMNS,
  MIN_COLUMNS,
  MIN_COLUMN_WIDTH,
  normalizeColumnWidth,
} from './columns-markdown';

export interface ColumnContainerInfo {
  /** Open-token position of the `columns` container. */
  columnsPos: number;
  columnsNode: PMNode;
  /** Open-token position of the selected block's `column`. */
  columnPos: number;
  columnIndex: number;
}

/** Resolve the nearest `column` → `columns` ancestor of a position. */
export function findColumnContainer(doc: PMNode, pos: number): ColumnContainerInfo | null {
  const $pos = doc.resolve(pos);
  for (let depth = $pos.depth; depth >= 1; depth -= 1) {
    if ($pos.node(depth).type.name !== 'column') continue;
    const parentDepth = depth - 1;
    if (parentDepth < 1 || $pos.node(parentDepth).type.name !== 'columns') return null;
    return {
      columnsPos: $pos.before(parentDepth),
      columnsNode: $pos.node(parentDepth),
      columnPos: $pos.before(depth),
      columnIndex: $pos.index(parentDepth),
    };
  }
  return null;
}

/**
 * Only top-level blocks can be split. Blocks that already live in a column are
 * rejected so the "no nested columns" rule holds at the command layer too.
 */
export function canSplitBlockToColumns(editor: Editor, blockPos: number): boolean {
  if (editor.isDestroyed || !editor.view) return false;
  const { doc } = editor.state;
  if (blockPos < 0 || blockPos > doc.content.size) return false;
  try {
    const $pos = doc.resolve(blockPos);
    // A top-level block's open position resolves at depth 0 with the document
    // as its parent; any deeper position belongs to a block's content.
    if ($pos.parent.type.name !== 'doc') return false;
    const node = $pos.parent.child($pos.index());
    return !!node && node.type.name !== 'columns' && node.type.name !== 'column';
  } catch {
    return false;
  }
}

/**
 * Turn the target block and its right sibling into a two-column block. When
 * the target is the last top-level block the right column starts empty.
 */
export function splitBlockToColumns(editor: Editor, blockPos: number): boolean {
  return splitBlocksIntoColumns(editor, blockPos, 2);
}

function distributeBlocks(blocks: readonly PMNode[], count: number): PMNode[][] {
  const groups: PMNode[][] = Array.from({ length: count }, () => []);
  if (blocks.length === 0) return groups;
  blocks.forEach((block, index) => {
    const group = Math.min(count - 1, Math.floor((index * count) / blocks.length));
    groups[group].push(block);
  });
  return groups;
}

export interface SplitBlockRange {
  from: number;
  to: number;
}

/**
 * Split the target block (and optionally the selected block ranges) into
 * `count` columns. Empty groups become empty columns, so a single block can
 * still be expanded into two or three columns.
 *
 * `ranges` comes from the block-selection plugin; they are only used when they
 * are top-level and strictly contiguous. Otherwise the command falls back to
 * consecutive top-level siblings starting at `blockPos`.
 */
export function splitBlocksIntoColumns(
  editor: Editor,
  blockPos: number,
  count: 2 | 3 | 4 | 5,
  ranges?: readonly SplitBlockRange[],
  options?: { onlyTarget?: boolean },
): boolean {
  if (editor.isDestroyed || !editor.view) return false;
  const { state } = editor;
  const doc = state.doc;
  const paragraph = state.schema.nodes.paragraph;
  const columnType = state.schema.nodes.column;
  const columnsType = state.schema.nodes.columns;
  if (!paragraph || !columnType || !columnsType) return false;

  const blocks: PMNode[] = [];
  let from = blockPos;
  let to = blockPos;

  const selected = ranges && ranges.length > 0 ? [...ranges] : null;
  if (selected) {
    let expected = selected[0].from;
    for (const range of selected) {
      if (range.from !== expected || range.to <= range.from) break;
      const $pos = doc.resolve(range.from);
      if ($pos.parent.type.name !== 'doc') break;
      const node = doc.nodeAt(range.from);
      if (!node || range.to !== range.from + node.nodeSize) break;
      blocks.push(node);
      expected = range.to;
    }
    if (blocks.length === selected.length) {
      from = selected[0].from;
      to = expected;
    } else {
      blocks.length = 0;
    }
  }

  if (blocks.length === 0) {
    const $pos = doc.resolve(blockPos);
    if ($pos.parent.type.name !== 'doc') return false;
    const startIndex = $pos.index();
    const available = Math.min(count, $pos.parent.childCount - startIndex);
    if (available <= 0) return false;
    from = blockPos;
    to = blockPos;
    if (options?.onlyTarget) {
      const node = $pos.parent.child(startIndex);
      blocks.push(node);
      to = blockPos + node.nodeSize;
    } else {
      for (let i = 0; i < available; i += 1) {
        const node = $pos.parent.child(startIndex + i);
        blocks.push(node);
        to += node.nodeSize;
      }
    }
  }

  if (blocks.length === 0) return false;

  const groups = distributeBlocks(blocks, count);
  const columnsNode = columnsType.create(
    null,
    groups.map((group) => columnType.create(
      { width: COLUMN_WIDTH_UNIT },
      group.length > 0 ? group : [paragraph.create()],
    )),
  );

  editor.view.dispatch(state.tr.replaceWith(from, to, columnsNode));
  return true;
}

function evenlyDistribute(count: number): number[] {
  return Array.from({ length: count }, () => COLUMN_WIDTH_UNIT);
}

function columnOffset(columnsNode: PMNode, columnsPos: number, index: number): number {
  let offset = columnsPos + 1;
  for (let i = 0; i < index; i += 1) offset += columnsNode.child(i).nodeSize;
  return offset;
}

/** Insert an empty column at `index` (default: the end). */
export function insertColumn(editor: Editor, columnsPos: number, index?: number): boolean {
  if (editor.isDestroyed || !editor.view) return false;
  const { state } = editor;
  const node = state.doc.nodeAt(columnsPos);
  if (!node || node.type.name !== 'columns' || node.childCount >= MAX_COLUMNS) return false;

  const columnType = state.schema.nodes.column;
  const paragraph = state.schema.nodes.paragraph;
  if (!columnType || !paragraph) return false;

  const insertIndex = Math.min(Math.max(index ?? node.childCount, 0), node.childCount);
  const insertPos = columnOffset(node, columnsPos, insertIndex);
  const tr = state.tr.insert(
    insertPos,
    columnType.create({ width: COLUMN_WIDTH_UNIT }, [paragraph.create()]),
  );
  const updated = tr.doc.nodeAt(columnsPos);
  if (!updated || updated.type.name !== 'columns') return false;

  const widths = evenlyDistribute(updated.childCount);
  for (let i = 0; i < updated.childCount; i += 1) {
    const column = updated.child(i);
    tr.setNodeMarkup(columnOffset(updated, columnsPos, i), undefined, {
      ...column.attrs,
      width: widths[i],
    });
  }
  editor.view.dispatch(tr);
  return true;
}

function isEmptyColumnNode(column: PMNode): boolean {
  if (column.childCount !== 1) return false;
  const onlyChild = column.firstChild;
  return !!onlyChild
    && onlyChild.type.name === 'paragraph'
    && onlyChild.content.size === 0;
}

/**
 * Delete one column. Its content is hoisted after the container so nothing is
 * lost; when only one column remains the whole container dissolves so the
 * document keeps the `column{2,3}` invariant.
 */
export function deleteColumn(editor: Editor, columnsPos: number, columnIndex: number): boolean {
  if (editor.isDestroyed || !editor.view) return false;
  const { state } = editor;
  const node = state.doc.nodeAt(columnsPos);
  if (!node || node.type.name !== 'columns') return false;
  if (columnIndex < 0 || columnIndex >= node.childCount) return false;

  if (node.childCount <= MIN_COLUMNS) {
    const remaining = Array.from({ length: node.childCount }, (_, i) => i)
      .filter((i) => i !== columnIndex)
      .map((i) => node.child(i))[0];
    if (!remaining) return false;
    editor.view.dispatch(
      state.tr.replaceWith(columnsPos, columnsPos + node.nodeSize, remaining.content),
    );
    return true;
  }

  const column = node.child(columnIndex);
  const from = columnOffset(node, columnsPos, columnIndex);
  const to = from + column.nodeSize;
  const tr = state.tr;

  // Hoist the column's content after the container before removing the column.
  // An empty column contributes nothing, so it is simply dropped.
  if (!isEmptyColumnNode(column)) {
    tr.insert(columnsPos + node.nodeSize, column.content);
  }
  tr.delete(from, to);

  const updated = tr.doc.nodeAt(columnsPos);
  if (!updated || updated.type.name !== 'columns') return false;

  const widths = evenlyDistribute(updated.childCount);
  for (let i = 0; i < updated.childCount; i += 1) {
    const updatedColumn = updated.child(i);
    tr.setNodeMarkup(columnOffset(updated, columnsPos, i), undefined, {
      ...updatedColumn.attrs,
      width: widths[i],
    });
  }
  editor.view.dispatch(tr);
  return true;
}

function topLevelBlockAt(doc: PMNode, pos: number): { node: PMNode; pos: number } | null {
  try {
    const $pos = doc.resolve(pos)
    const topPos = $pos.depth === 0 ? pos : $pos.before(1)
    const node = doc.nodeAt(topPos)
    return node ? { node, pos: topPos } : null
  } catch {
    return null
  }
}

/**
 * Add an empty column beside the block, leaving the block's own content in
 * place. This is the "split right" menu action: Notion creates a new empty
 * column, it does not move the neighbouring block into it.
 */
export function addColumnBesideBlock(
  editor: Editor,
  blockPos: number,
  side: 'left' | 'right' = 'right',
): boolean {
  if (editor.isDestroyed || !editor.view) return false
  const { state } = editor
  const { doc, schema } = state

  const container = findColumnContainer(doc, blockPos)
  if (container) return insertColumnAtSide(editor, container.columnPos, side)

  const block = topLevelBlockAt(doc, blockPos)
  if (!block) return false

  // A top-level columns container already owns the horizontal layout; add a
  // column at the requested edge of that container.
  if (block.node.type.name === 'columns') {
    const index = side === 'left' ? 0 : block.node.childCount
    return insertColumn(editor, block.pos, index)
  }

  const columnType = schema.nodes.column
  const columnsType = schema.nodes.columns
  const paragraph = schema.nodes.paragraph
  if (!columnType || !columnsType || !paragraph) return false

  const contentColumn = columnType.create({ width: COLUMN_WIDTH_UNIT }, [block.node])
  const emptyColumn = columnType.create({ width: COLUMN_WIDTH_UNIT }, [paragraph.create()])
  const columnsNode = columnsType.create(
    null,
    side === 'left' ? [emptyColumn, contentColumn] : [contentColumn, emptyColumn],
  )
  editor.view.dispatch(
    state.tr.replaceWith(block.pos, block.pos + block.node.nodeSize, columnsNode),
  )
  return true
}

/** Insert a column next to the column at `columnPos`. */
export function insertColumnAtSide(
  editor: Editor,
  columnPos: number,
  side: 'left' | 'right',
): boolean {
  if (editor.isDestroyed || !editor.view) return false;
  try {
    const $pos = editor.state.doc.resolve(columnPos);
    if ($pos.parent.type.name !== 'columns') return false;
    const index = $pos.index() + (side === 'right' ? 1 : 0);
    return insertColumn(editor, $pos.before(), index);
  } catch {
    return false;
  }
}

/** Delete the column at `columnPos` (content is hoisted by deleteColumn). */
export function deleteColumnAt(editor: Editor, columnPos: number): boolean {
  if (editor.isDestroyed || !editor.view) return false;
  try {
    const $pos = editor.state.doc.resolve(columnPos);
    if ($pos.parent.type.name !== 'columns') return false;
    return deleteColumn(editor, $pos.before(), $pos.index());
  } catch {
    return false;
  }
}

export function setColumnWidths(
  editor: Editor,
  columnsPos: number,
  widths: readonly number[],
): boolean {
  if (editor.isDestroyed || !editor.view) return false;
  const { state } = editor;
  const node = state.doc.nodeAt(columnsPos);
  if (!node || node.type.name !== 'columns' || widths.length !== node.childCount) return false;

  const tr = state.tr;
  let changed = false;
  for (let i = 0; i < node.childCount; i += 1) {
    const column = node.child(i);
    const width = normalizeColumnWidth(widths[i]);
    if (column.attrs.width === width) continue;
    tr.setNodeMarkup(columnOffset(node, columnsPos, i), undefined, {
      ...column.attrs,
      width,
    });
    changed = true;
  }
  if (!changed) return false;
  editor.view.dispatch(tr);
  return true;
}

/**
 * Pure width split used by the resize handle. Only the dragged pair changes;
 * their total stays constant so the page width and the other columns do not
 * move. `MIN_COLUMN_WIDTH` is applied to both sides.
 */
export function resolveColumnResize(
  widths: readonly number[],
  index: number,
  deltaPx: number,
  containerWidth: number,
): number[] {
  const result = [...widths];
  if (index < 0 || index >= widths.length - 1 || containerWidth <= 0) return result;

  const left = widths[index];
  const right = widths[index + 1];
  const pair = left + right;
  if (pair < MIN_COLUMN_WIDTH * 2) return result;

  const total = widths.reduce((sum, width) => sum + width, 0);
  const deltaWeight = Math.round((deltaPx / containerWidth) * total);
  const nextLeft = Math.min(
    Math.max(left + deltaWeight, MIN_COLUMN_WIDTH),
    pair - MIN_COLUMN_WIDTH,
  );
  if (!Number.isFinite(nextLeft)) return result;

  result[index] = nextLeft;
  result[index + 1] = pair - nextLeft;
  return result;
}
