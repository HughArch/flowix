import type { Editor } from '@tiptap/core'
import { Extension } from '@tiptap/core'
import { Fragment, type Node as PMNode } from 'prosemirror-model'
import { Plugin, PluginKey, Selection, type Transaction } from 'prosemirror-state'
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view'
import { getCurrentBlockInfo, type CurrentBlockInfo } from '@features/editor/components/drag-context-menu/block-info'
import { resolveBlockContainer } from './block-selection'
import { findColumnContainer } from './columns/columns-commands'
import { COLUMN_WIDTH_UNIT, MAX_COLUMNS } from './columns/columns-markdown'
import {
  canMergeListRuns,
  createListOfType,
  isListTypeName,
  itemTypeForList,
  itemsOf,
  listWithItems,
  LIST_ITEM_TYPES,
  LIST_TYPES,
  type ListTypeName,
} from './list-structure'

interface DraggedBlockRange {
  from: number
  to: number
  parentStart: number
  parentTypeName: string
  isListItem: boolean
  sourceDepth: number
  sourceListTypeName: string | null
}

export interface BlockDropTarget {
  insertPos: number
  listPos: number
  listTypeName: string
  createList: boolean
  anchorPos: number
  anchorDepth: number
  desiredDepth: number
  side: 'before' | 'after'
  splitList?: { listPos: number; boundaryIndex: number }
  nestList?: { itemPos: number }
  /**
   * Horizontal drop gesture. When present, `moveDraggedBlock` uses the column
   * branch instead of the vertical insertion path.
   */
  columnTarget?: ColumnDropTarget
}

export type ColumnDropTarget =
  | {
      kind: 'new-column'
      side: 'left' | 'right'
      /** Block or `columns` container the new column is created next to. */
      anchorPos: number
      anchorNodeSize: number
      /** Present when the anchor is a column inside an existing container. */
      columnsPos?: number
      columnIndex?: number
    }
  | {
      kind: 'into-column'
      columnPos: number
      insertPos: number
    }

interface BlockDragState extends DraggedBlockRange {
  /**
   * Every block moved by this gesture, in document order. The primary range
   * (the one whose handle started the drag) is duplicated at the top level
   * for the single-block code paths and for drop-target resolution.
   */
  ranges: DraggedBlockRange[]
  /** Kept for the existing drop-line API and backwards-compatible tests. */
  dropPos: number | null
  dropTarget: BlockDropTarget | null
}

export interface BlockDragTarget {
  pos: number
  nodeSize: number
}

export const blockDragPluginKey = new PluginKey<BlockDragState | null>('blockDrag')

/** Editor-level block move state. List items are moved as complete nodes. */
export const BlockDragExtension = Extension.create({
  name: 'blockDrag',

  addProseMirrorPlugins() {
    return [
      new Plugin<BlockDragState | null>({
        key: blockDragPluginKey,
        state: {
          init: () => null,
          apply(tr, value) {
            const meta = tr.getMeta(blockDragPluginKey)
            if (meta !== undefined) return meta
            if (!value || !tr.docChanged) return value

            // Keep insertions at either boundary out of the dragged node.
            const from = tr.mapping.mapResult(value.from, 1)
            const to = tr.mapping.mapResult(value.to, -1)
            if (from.deletedAcross || to.deletedAcross || from.pos >= to.pos) return null
            const node = tr.doc.nodeAt(from.pos)
            if (!node || node.type !== tr.before.nodeAt(value.from)?.type
              || to.pos !== from.pos + node.nodeSize) return null
            const ranges = mapDraggedRanges(tr, value.ranges, value.from, from.pos, to.pos)
            if (ranges.length === 0) return null
            const container = resolveBlockContainer(tr.doc, from.pos)
            if (!container || container.parentTypeName !== value.parentTypeName) return null
            return {
              ...value,
              from: from.pos,
              to: to.pos,
              parentStart: container.parentStart,
              sourceDepth: value.isListItem ? getListItemDepth(tr.doc, from.pos) : 0,
              ranges,
              dropPos: value.dropPos == null ? null : tr.mapping.map(value.dropPos, -1),
              dropTarget: value.dropTarget ? mapDropTarget(value.dropTarget, tr.mapping) : null,
            }
          },
        },
        props: {
          decorations(state) {
            const drag = blockDragPluginKey.getState(state)
            if (!drag) return null

            const decorations = []
            for (const range of drag.ranges) {
              const draggedNode = state.doc.nodeAt(range.from)
              if (draggedNode && range.to === range.from + draggedNode.nodeSize) {
                decorations.push(Decoration.node(range.from, range.to, {
                  class: 'flowix-block-drag-source',
                }))
              }
            }

            const columnTarget = drag.dropTarget?.columnTarget
            if (columnTarget?.kind === 'new-column') {
              decorations.push(Decoration.node(
                columnTarget.anchorPos,
                columnTarget.anchorPos + columnTarget.anchorNodeSize,
                {
                  class: columnTarget.side === 'left'
                    ? 'flowix-column-drop-left'
                    : 'flowix-column-drop-right',
                },
              ))
            } else {
              const dropPos = drag.dropTarget?.insertPos ?? drag.dropPos
              if (dropPos != null) {
                decorations.push(Decoration.widget(dropPos, () => {
                  const marker = document.createElement('div')
                  marker.className = 'flowix-block-drop-indicator'
                  marker.contentEditable = 'false'
                  return marker
                }, { side: -1 }))
              }
            }

            return decorations.length > 0
              ? DecorationSet.create(state.doc, decorations)
              : null
          },
        },
      }),
    ]
  },
})

export function startBlockDrag(
  editor: Editor,
  info?: CurrentBlockInfo | null,
  additionalBlocks: BlockDragTarget[] = [],
): boolean {
  if (editor.isDestroyed || !editor.isEditable) return false
  const block = info ?? getCurrentBlockInfo(editor)
  if (!block) return false
  return startBlockDragForView(editor.view, block, additionalBlocks)
}

export function startBlockDragForView(
  view: EditorView,
  block: BlockDragTarget,
  additionalBlocks: BlockDragTarget[] = [],
): boolean {
  if (view.isDestroyed) return false

  const primary = draggedRangeAt(view, block)
  if (!primary) return false

  // A set may span containers (a list item plus a heading). The drag layer
  // treats such mixed sets as a root-level move and wraps list items in lists
  // on insert, so every selected block travels.
  const ranges = [primary]
  for (const extra of additionalBlocks) {
    if (extra.pos === primary.from) continue
    const range = draggedRangeAt(view, extra)
    if (!range) continue
    ranges.push(range)
  }
  ranges.sort((left, right) => left.from - right.from)

  const range: BlockDragState = {
    ...primary,
    ranges,
    dropPos: null,
    dropTarget: null,
  }

  view.dispatch(view.state.tr.setMeta(blockDragPluginKey, range))
  return true
}

function draggedRangeAt(view: EditorView, block: BlockDragTarget): DraggedBlockRange | null {
  const node = view.state.doc.nodeAt(block.pos)
  if (!node) return null
  const container = resolveBlockContainer(view.state.doc, block.pos)
  if (!container) return null
  const parent = container.parent
  const isListItem = LIST_ITEM_TYPES.has(node.type.name) && LIST_TYPES.has(parent.type.name)
  return {
    from: block.pos,
    to: block.pos + node.nodeSize,
    parentStart: container.parentStart,
    parentTypeName: container.parentTypeName,
    isListItem,
    sourceDepth: isListItem ? getListItemDepth(view.state.doc, block.pos) : 0,
    sourceListTypeName: isListItem ? parent.type.name : null,
  }
}

function mapDraggedRanges(
  tr: Transaction,
  ranges: readonly DraggedBlockRange[],
  primaryFrom: number,
  mappedPrimaryFrom: number,
  mappedPrimaryTo: number,
): DraggedBlockRange[] {
  const mapped: DraggedBlockRange[] = []
  for (const range of ranges) {
    const isPrimary = range.from === primaryFrom
    const from = isPrimary ? { pos: mappedPrimaryFrom, deletedAcross: false } : tr.mapping.mapResult(range.from, 1)
    const to = isPrimary ? { pos: mappedPrimaryTo, deletedAcross: false } : tr.mapping.mapResult(range.to, -1)
    if (from.deletedAcross || to.deletedAcross || from.pos >= to.pos) continue

    // Re-resolve the container: a preceding edit can shift the list that owns
    // this block, and `buildDraggedNodes` looks the source list up by
    // `parentStart`.
    const container = resolveBlockContainer(tr.doc, from.pos)
    const node = tr.doc.nodeAt(from.pos)
    const isListItem = Boolean(
      node
      && container
      && LIST_ITEM_TYPES.has(node.type.name)
      && LIST_TYPES.has(container.parentTypeName),
    )
    mapped.push({
      ...range,
      from: from.pos,
      to: to.pos,
      parentStart: container?.parentStart ?? range.parentStart,
      parentTypeName: container?.parentTypeName ?? range.parentTypeName,
      isListItem,
      sourceDepth: isListItem ? getListItemDepth(tr.doc, from.pos) : 0,
      sourceListTypeName: isListItem ? container!.parentTypeName : null,
    })
  }
  return mapped
}

export function endBlockDrag(editor: Editor): void {
  if (editor.isDestroyed) return
  endBlockDragForView(editor.view)
}

export const cancelBlockDrag = endBlockDrag

export function endBlockDragForView(view: EditorView): void {
  if (view.isDestroyed) return
  view.dispatch(view.state.tr.setMeta(blockDragPluginKey, null))
}

export const cancelBlockDragForView = endBlockDragForView

export function updateBlockDragPosition(editor: Editor, clientX: number, clientY: number): boolean {
  if (editor.isDestroyed) return false
  return updateBlockDragPositionForView(editor.view, clientX, clientY)
}

export function dropBlockDragAt(editor: Editor, clientX: number, clientY: number): boolean {
  if (editor.isDestroyed) return false
  return dropBlockDragAtForView(editor.view, clientX, clientY)
}

export function updateBlockDragPositionForView(view: EditorView, clientX: number, clientY: number): boolean {
  const drag = blockDragPluginKey.getState(view.state)
  if (!drag) return false

  const target = getValidDropTarget(view, drag, clientX, clientY)
  const dropPos = target?.insertPos ?? null
  if (drag.dropPos !== dropPos
    || drag.dropTarget?.splitList?.listPos !== target?.splitList?.listPos
    || drag.dropTarget?.splitList?.boundaryIndex !== target?.splitList?.boundaryIndex
    || drag.dropTarget?.nestList?.itemPos !== target?.nestList?.itemPos) {
    view.dispatch(view.state.tr.setMeta(blockDragPluginKey, {
      ...drag,
      dropPos,
      dropTarget: target,
    }))
  }
  return target != null
}

export function dropBlockDragAtForView(view: EditorView, clientX: number, clientY: number): boolean {
  if (view.isDestroyed) return false
  return moveDraggedBlock(view, clientX, clientY)
}

function getValidDropTarget(
  view: EditorView,
  drag: BlockDragState,
  clientX: number,
  clientY: number,
): BlockDropTarget | null {
  const editorRect = view.dom.getBoundingClientRect()
  if (editorRect.width > 0 && editorRect.height > 0
    && (clientX < editorRect.left - 48 || clientX > editorRect.right + 48
      || clientY < editorRect.top - 48 || clientY > editorRect.bottom + 48)) return null

  const context = dragContext(drag)
  const columnTarget = findColumnDropTarget(view, drag, clientX, clientY)
  if (columnTarget) return columnTarget
  if (isUniformListDrag(drag)) {
    const target = findListDropTarget(view, context, clientX, clientY)
    return target && isValidDropPos(view, context, target) ? target : null
  }

  // Mixed sets (list items + ordinary blocks) only promise root-level
  // insertion: a non-list block cannot become a list item.
  if (!needsRootDragContext(drag)) {
    const splitTarget = findSplitListTarget(view, context, clientX, clientY)
    if (splitTarget && isValidDropPos(view, context, splitTarget)) return splitTarget
  }

  const dropPos = findInsertPos(view, context, clientX, clientY)
  const target = dropPos == null ? null : makeGenericDropTarget(dropPos)
  return target && isValidDropPos(view, context, target)
    ? target
    : null
}

/**
 * A drag whose blocks all live in the same list keeps the list-aware targets
 * (reorder inside the list, create/split/nest lists). Anything else either
 * uses its own parent (ordinary blocks) or is promoted to root level (mixed
 * list + non-list sets).
 */
function isUniformListDrag(drag: Pick<BlockDragState, 'ranges'>): boolean {
  const [first] = drag.ranges
  if (!first || !first.isListItem) return false
  return drag.ranges.every((range) => range.isListItem && range.parentStart === first.parentStart)
}

function needsRootDragContext(drag: Pick<BlockDragState, 'ranges'>): boolean {
  const [first] = drag.ranges
  if (!first) return false
  const spansContainers = drag.ranges.some((range) => (
    range.parentStart !== first.parentStart || range.parentTypeName !== first.parentTypeName
  ))
  const hasListItem = drag.ranges.some((range) => range.isListItem)
  const hasOther = drag.ranges.some((range) => !range.isListItem)
  return spansContainers || (hasListItem && hasOther)
}

function dragContext(drag: BlockDragState): BlockDragState {
  if (!needsRootDragContext(drag)) return drag
  return {
    ...drag,
    parentStart: 0,
    parentTypeName: 'doc',
    isListItem: false,
    sourceDepth: 0,
    sourceListTypeName: null,
  }
}

/**
 * Nodes to insert, in document order. Consecutive list items are wrapped in a
 * list of their source type so the fragment is valid at a root-level target;
 * ordinary blocks pass through unchanged.
 */
function buildDraggedNodes(
  state: EditorView['state'],
  drag: Pick<BlockDragState, 'ranges'>,
): PMNode[] {
  const nodes: PMNode[] = []
  let pendingItems: PMNode[] = []
  let pendingList: PMNode | null = null
  let pendingStartIndex = 0
  const flush = () => {
    if (pendingItems.length === 0 || !pendingList) return
    nodes.push(wrapDraggedItems(state, pendingList, pendingItems, pendingStartIndex))
    pendingItems = []
    pendingList = null
  }

  for (const range of drag.ranges) {
    const node = state.doc.nodeAt(range.from)
    if (!node) continue
    if (range.isListItem) {
      const list = state.doc.nodeAt(range.parentStart - 1)
      if (list && isListTypeName(list.type.name)) {
        if (pendingList && pendingList.type.name !== list.type.name) flush()
        if (pendingItems.length === 0) {
          pendingList = list
          pendingStartIndex = resolveBlockContainer(state.doc, range.from)?.index ?? 0
        }
        pendingItems.push(node)
        continue
      }
    }
    flush()
    nodes.push(node)
  }
  flush()
  return nodes
}

/** Whether an insertion at `insertPos` lands outside every list container. */
function shouldWrapInsertionInList(state: EditorView['state'], insertPos: number): boolean {
  try {
    const doc = state.doc
    const $pos = doc.resolve(Math.min(Math.max(insertPos, 0), doc.content.size))
    if ($pos.depth === 0) return true
    return !LIST_TYPES.has($pos.parent.type.name)
  } catch {
    return true
  }
}

/** Remove emptied source lists after the dragged runs are deleted. */
function cleanupSourceLists(
  tr: Transaction,
  state: EditorView['state'],
  drag: Pick<BlockDragState, 'ranges'>,
): void {
  const removedByList = new Map<number, number>()
  for (const range of drag.ranges) {
    if (!range.isListItem) continue
    const listPos = range.parentStart - 1
    removedByList.set(listPos, (removedByList.get(listPos) ?? 0) + 1)
  }
  for (const [listPos, removedCount] of removedByList) {
    const list = state.doc.nodeAt(listPos)
    if (!list || !LIST_TYPES.has(list.type.name)) continue
    cleanupSourceList(tr, tr.mapping.map(listPos, -1), list.childCount === removedCount)
  }
  removeEmptyLists(tr)
}

function makeGenericDropTarget(insertPos: number): BlockDropTarget {
  return {
    insertPos,
    listPos: -1,
    listTypeName: '',
    createList: false,
    anchorPos: insertPos,
    anchorDepth: 0,
    desiredDepth: 0,
    side: 'before',
  }
}

function makeColumnTarget(
  columnTarget: ColumnDropTarget,
  insertPos: number,
): BlockDropTarget {
  return { ...makeGenericDropTarget(insertPos), columnTarget }
}

function findColumnInsertPos(
  view: EditorView,
  columnPos: number,
  clientY: number,
): number | null {
  const column = view.state.doc.nodeAt(columnPos)
  if (!column || column.type.name !== 'column') return null

  let offset = 0
  for (let index = 0; index < column.childCount; index += 1) {
    const child = column.child(index)
    const childPos = columnPos + 1 + offset
    const dom = view.nodeDOM(childPos)
    if (dom instanceof HTMLElement) {
      const rect = dom.getBoundingClientRect()
      if (clientY < rect.top + rect.height / 2) return childPos
    }
    offset += child.nodeSize
  }
  return columnPos + 1 + column.content.size
}

function findRootInsertPos(view: EditorView, clientY: number): number | null {
  const { doc } = view.state
  let offset = 0
  for (let index = 0; index < doc.childCount; index += 1) {
    const child = doc.child(index)
    const childPos = offset
    const dom = view.nodeDOM(childPos)
    if (dom instanceof HTMLElement) {
      const rect = dom.getBoundingClientRect()
      if (clientY < rect.top + rect.height / 2) return childPos
    }
    offset += child.nodeSize
  }
  return doc.content.size
}

interface DomColumnContext {
  columnPos: number
  columnsPos: number
  columnIndex: number
  columnsNode: PMNode
  columnNode: PMNode
  columnDom: HTMLElement
}

/**
 * Resolve the column under the pointer from the DOM instead of
 * `posAtCoords`. The coordinate lookup can land on a gap or the document root
 * when the pointer is near a column edge, which made it impossible to drop
 * into a column from outside.
 */
function resolveColumnFromDom(
  view: EditorView,
  clientX: number,
  clientY: number,
): DomColumnContext | null {
  if (typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') {
    return null
  }
  let element: Element | null = null
  try {
    element = document.elementFromPoint(clientX, clientY)
  } catch {
    return null
  }
  if (!(element instanceof HTMLElement)) return null
  const columnDom = element.closest<HTMLElement>('.flowix-column')
  if (!columnDom || !view.dom.contains(columnDom)) return null

  try {
    const pos = view.posAtDOM(columnDom, 0)
    const doc = view.state.doc
    const direct = doc.nodeAt(pos)
    if (direct?.type.name === 'column') {
      const $pos = doc.resolve(pos)
      return {
        columnPos: pos,
        columnsPos: $pos.before(),
        columnIndex: $pos.index(),
        columnsNode: $pos.parent,
        columnNode: direct,
        columnDom,
      }
    }

    const $pos = doc.resolve(pos)
    for (let depth = $pos.depth; depth >= 1; depth -= 1) {
      if ($pos.node(depth).type.name !== 'column') continue
      const parentDepth = depth - 1
      if (parentDepth < 1 || $pos.node(parentDepth).type.name !== 'columns') return null
      return {
        columnPos: $pos.before(depth),
        columnsPos: $pos.before(parentDepth),
        columnIndex: $pos.index(parentDepth),
        columnsNode: $pos.node(parentDepth),
        columnNode: $pos.node(depth),
        columnDom,
      }
    }
  } catch {
    return null
  }
  return null
}

/**
 * Horizontal drop resolution for ordinary blocks:
 *
 * - the left/right edge of a block creates a new column next to it;
 * - the middle of a block in another column inserts vertically into that
 *   column;
 * - a block dragged out of a column onto the document root becomes a normal
 *   vertical drop.
 *
 * Returning null keeps the existing vertical / list logic in charge.
 */
function findColumnDropTarget(
  view: EditorView,
  drag: BlockDragState,
  clientX: number,
  clientY: number,
): BlockDropTarget | null {
  // Lists keep their list-aware drop semantics.
  if (drag.isListItem) return null

  const domColumn = resolveColumnFromDom(view, clientX, clientY)

  let coords: { pos: number; inside: number } | null = null
  if (!domColumn) {
    try {
      coords = view.posAtCoords({ left: clientX, top: clientY })
    } catch {
      // jsdom and other DOM shims do not implement elementFromPoint.
      return null
    }
    if (!coords) return null
  }

  const { doc } = view.state
  const container = domColumn ?? (coords ? findColumnContainer(doc, coords.pos) : null)

  let anchorPos: number
  if (container) {
    anchorPos = container.columnPos
  } else {
    const $pos = doc.resolve(coords!.pos)
    if ($pos.depth >= 1) {
      anchorPos = $pos.before(1)
    } else {
      // The pointer sits at the document root (a block boundary). Resolve the
      // top-level child under it from the content index.
      const index = $pos.index()
      if (index >= $pos.parent.childCount) return null
      anchorPos = 0
      for (let i = 0; i < index; i += 1) anchorPos += $pos.parent.child(i).nodeSize
    }
  }

  const anchorNode = container
    ? (domColumn?.columnNode ?? container.columnsNode.child(container.columnIndex))
    : doc.nodeAt(anchorPos)
  const anchorDom = container
    ? (domColumn?.columnDom ?? view.nodeDOM(container.columnPos))
    : view.nodeDOM(anchorPos)
  if (!anchorNode || !(anchorDom instanceof HTMLElement)) return null

  const sameColumn = container
    ? drag.parentStart === container.columnPos + 1
    : drag.parentTypeName === 'doc' && drag.parentStart === 0

  const rect = anchorDom.getBoundingClientRect()
  if (rect.height > 0 && clientY >= rect.top && clientY <= rect.bottom) {
    const edge = Math.min(96, rect.width * 0.3)
    const side = clientX <= rect.left + edge ? 'left' as const
      : clientX >= rect.right - edge ? 'right' as const
        : null

    if (side) {
      if (container) {
        if (container.columnsNode.childCount >= MAX_COLUMNS) return null
        if (drag.ranges.some((range) => container.columnPos >= range.from && container.columnPos < range.to)) return null
        return makeColumnTarget({
          kind: 'new-column',
          side,
          anchorPos: container.columnPos,
          anchorNodeSize: anchorNode.nodeSize,
          columnsPos: container.columnsPos,
          columnIndex: container.columnIndex,
        }, container.columnPos)
      }
      if (drag.ranges.some((range) => anchorPos >= range.from && anchorPos < range.to)) return null
      if (anchorNode.type.name === 'columns' && anchorNode.childCount >= MAX_COLUMNS) return null
      return makeColumnTarget({
        kind: 'new-column',
        side,
        anchorPos,
        anchorNodeSize: anchorNode.nodeSize,
      }, anchorPos)
    }
  }

  if (container && !sameColumn) {
    const insertPos = findColumnInsertPos(view, container.columnPos, clientY)
    if (insertPos == null) return null
    const target = makeGenericDropTarget(insertPos)
    target.columnTarget = { kind: 'into-column', columnPos: container.columnPos, insertPos }
    return isValidDropPos(view, drag, target) ? target : null
  }

  if (!container && drag.parentTypeName === 'column') {
    const insertPos = findRootInsertPos(view, clientY)
    if (insertPos == null) return null
    const target = makeGenericDropTarget(insertPos)
    return isValidDropPos(view, drag, target) ? target : null
  }

  return null
}

function moveDraggedBlock(view: EditorView, clientX: number, clientY: number): boolean {
  const drag = blockDragPluginKey.getState(view.state)
  if (!drag) return false

  // Re-resolve on pointerup because the final animation-frame update may not
  // have run yet, and list targets depend on the final vertical coordinate.
  const target = getValidDropTarget(view, drag, clientX, clientY)
  if (!target) {
    view.dispatch(view.state.tr.setMeta(blockDragPluginKey, null))
    return false
  }

  const { state } = view
  if (target.columnTarget?.kind === 'new-column') {
    return moveDraggedBlockToNewColumn(view, drag, target.columnTarget)
  }
  if (target.splitList) return moveBlockBetweenListItems(view, drag, target.splitList)
  if (target.nestList) return moveListItemIntoNestedList(view, drag, target.nestList)
  // A list item entering an existing list must stay a bare item; at a root
  // level target it has to be wrapped in a list to be schema-valid.
  const insertionNodes = shouldWrapInsertionInList(state, target.insertPos)
    ? buildDraggedNodes(state, drag)
    : draggedNodes(state, drag)
  if (insertionNodes.length === 0) {
    view.dispatch(state.tr.setMeta(blockDragPluginKey, null))
    return false
  }
  try {
    const tr = deleteDraggedRanges(state, drag)
    const mappedInsertPos = tr.mapping.map(target.insertPos, -1)
    tr.insert(mappedInsertPos, Fragment.fromArray(insertionNodes))
    cleanupSourceLists(tr, state, drag)
    if (target.createList) {
      // Cleanup may have removed a source list above the insertion point;
      // remap instead of reusing the stale mapped position.
      mergeAdjacentRootLists(tr, tr.mapping.map(target.insertPos, -1))
    }
    removeEmptyLists(tr)
    fillEmptyContainers(tr, state.schema)
    tr.setMeta(blockDragPluginKey, null)
    view.dispatch(tr.scrollIntoView())
    return true
  } catch {
    view.dispatch(state.tr.setMeta(blockDragPluginKey, null))
    return false
  }
}

function rebalanceColumnsInTransaction(tr: Transaction, columnsPos: number): void {
  const node = tr.doc.nodeAt(columnsPos)
  if (!node || node.type.name !== 'columns') return
  let offset = columnsPos + 1
  for (let index = 0; index < node.childCount; index += 1) {
    const column = node.child(index)
    tr.setNodeMarkup(offset, undefined, { ...column.attrs, width: COLUMN_WIDTH_UNIT })
    offset += column.nodeSize
  }
}

/**
 * Deleting the only block of a column (or callout) leaves a schema-invalid
 * empty container. Keep the container (the column UI shows an empty-column
 * placeholder) by restoring one empty paragraph.
 */
function fillEmptyContainers(tr: Transaction, schema: EditorView['state']['schema']): void {
  const paragraph = schema.nodes.paragraph
  if (!paragraph) return
  const empty: number[] = []
  tr.doc.descendants((node, pos) => {
    if (
      (node.type.name === 'column' || node.type.name === 'callout' || node.type.name === 'toggle')
      && node.childCount === 0
    ) {
      empty.push(pos)
    }
    return true
  })
  for (let index = empty.length - 1; index >= 0; index -= 1) {
    tr.insert(empty[index] + 1, paragraph.create())
  }
}

function moveDraggedBlockToNewColumn(
  view: EditorView,
  drag: BlockDragState,
  columnTarget: Extract<ColumnDropTarget, { kind: 'new-column' }>,
): boolean {
  const { state } = view
  const dragged = buildDraggedNodes(state, drag)
  if (dragged.length === 0) return false

  const columnType = state.schema.nodes.column
  const columnsType = state.schema.nodes.columns
  if (!columnType || !columnsType) return false

  try {
    const tr = deleteDraggedRanges(state, drag)
    const anchorPos = tr.mapping.map(columnTarget.anchorPos, -1)
    const anchorNode = tr.doc.nodeAt(anchorPos)
    if (!anchorNode) return false

    const newColumn = columnType.create({ width: COLUMN_WIDTH_UNIT }, dragged)

    if (anchorNode.type.name === 'columns') {
      if (anchorNode.childCount >= MAX_COLUMNS) return false
      const index = columnTarget.side === 'left' ? 0 : anchorNode.childCount
      let insertPos = anchorPos + 1
      for (let i = 0; i < index; i += 1) insertPos += anchorNode.child(i).nodeSize
      tr.insert(insertPos, newColumn)
      rebalanceColumnsInTransaction(tr, anchorPos)
    } else if (columnTarget.columnsPos != null && columnTarget.columnIndex != null) {
      const columnsPos = tr.mapping.map(columnTarget.columnsPos, -1)
      const columnsNode = tr.doc.nodeAt(columnsPos)
      if (!columnsNode || columnsNode.type.name !== 'columns') return false
      if (columnsNode.childCount >= MAX_COLUMNS) return false
      const index = columnTarget.columnIndex + (columnTarget.side === 'right' ? 1 : 0)
      let insertPos = columnsPos + 1
      for (let i = 0; i < index; i += 1) insertPos += columnsNode.child(i).nodeSize
      tr.insert(insertPos, newColumn)
      rebalanceColumnsInTransaction(tr, columnsPos)
    } else {
      const currentColumn = columnType.create({ width: COLUMN_WIDTH_UNIT }, [anchorNode])
      const columnsNode = columnsType.create(
        null,
        columnTarget.side === 'left'
          ? [newColumn, currentColumn]
          : [currentColumn, newColumn],
      )
      tr.replaceWith(anchorPos, anchorPos + anchorNode.nodeSize, columnsNode)
    }

    cleanupSourceLists(tr, state, drag)
    removeEmptyLists(tr)
    fillEmptyContainers(tr, state.schema)
    tr.setMeta(blockDragPluginKey, null)
    view.dispatch(tr.scrollIntoView())
    return true
  } catch {
    view.dispatch(state.tr.setMeta(blockDragPluginKey, null))
    return false
  }
}

/** Nodes moved by the gesture, in document order. */
function draggedNodes(state: EditorView['state'], drag: Pick<BlockDragState, 'ranges'>): PMNode[] {
  const nodes: PMNode[] = []
  for (const range of drag.ranges) {
    const node = state.doc.nodeAt(range.from)
    if (node) nodes.push(node)
  }
  return nodes
}

/** Delete every dragged run, bottom-up so earlier positions stay valid. */
function deleteDraggedRanges(state: EditorView['state'], drag: Pick<BlockDragState, 'ranges'>): Transaction {
  const tr = state.tr
  const ranges = [...drag.ranges].sort((left, right) => right.from - left.from)
  for (const range of ranges) tr.delete(range.from, range.to)
  return tr
}

function nestItemsInParent(
  state: EditorView['state'],
  parentItem: PMNode,
  sourceList: PMNode,
  sourceItems: readonly PMNode[],
  sourceIndex: number,
): PMNode {
  const children = itemsOf(parentItem)
  const lastChild = children[children.length - 1]
  const nestedList = lastChild?.type === sourceList.type
    ? lastChild.type.createChecked(lastChild.attrs, lastChild.content.append(Fragment.fromArray(sourceItems)))
    : createListOfType(state.schema, sourceList.type.name as ListTypeName, [...sourceItems],
      sourceList.type.name === 'orderedList'
        ? { ...sourceList.attrs, start: (Number(sourceList.attrs.start) || 1) + sourceIndex }
        : sourceList.attrs)
  const content = lastChild?.type === sourceList.type
    ? [...children.slice(0, -1), nestedList]
    : [...children, nestedList]
  return parentItem.type.createChecked(parentItem.attrs, Fragment.fromArray(content))
}

function moveListItemIntoNestedList(
  view: EditorView,
  drag: BlockDragState,
  target: NonNullable<BlockDropTarget['nestList']>,
): boolean {
  const { state } = view
  const sourceItems = draggedNodes(state, drag)
  const $source = state.doc.resolve(drag.from)
  const sourceList = $source.parent
  if (sourceItems.length === 0 || !isListTypeName(sourceList.type.name)) return false
  const sourceIndex = $source.index()
  const sourceListPos = drag.parentStart - 1
  try {
    const tr = deleteDraggedRanges(state, drag)
    const itemPos = tr.mapping.map(target.itemPos, -1)
    const parentItem = tr.doc.nodeAt(itemPos)
    if (!parentItem || !LIST_ITEM_TYPES.has(parentItem.type.name)) throw new Error('Drop item disappeared')
    const updated = nestItemsInParent(state, parentItem, sourceList, sourceItems, sourceIndex)
    const $item = tr.doc.resolve(itemPos)
    if (!$item.parent.canReplace($item.index(), $item.index() + 1, Fragment.from(updated))) {
      throw new Error('Drop item cannot contain the nested list')
    }
    tr.replaceWith(itemPos, itemPos + parentItem.nodeSize, updated)
    cleanupSourceList(
      tr,
      tr.mapping.map(sourceListPos, -1),
      sourceList.childCount === drag.ranges.length,
    )
    removeEmptyLists(tr)
    tr.setMeta(blockDragPluginKey, null)
    view.dispatch(tr.scrollIntoView())
    return true
  } catch {
    view.dispatch(state.tr.setMeta(blockDragPluginKey, null))
    return false
  }
}

function moveBlockBetweenListItems(
  view: EditorView,
  drag: BlockDragState,
  target: NonNullable<BlockDropTarget['splitList']>,
): boolean {
  const { state } = view
  const blocks = draggedNodes(state, drag)
  if (blocks.length === 0) return false
  const sourceList = drag.isListItem ? state.doc.resolve(drag.from).parent : null
  const sourceIndex = drag.isListItem ? state.doc.resolve(drag.from).index() : 0
  const sourceListPos = drag.isListItem ? drag.parentStart - 1 : null
  try {
    const tr = deleteDraggedRanges(state, drag)
    const listPos = tr.mapping.map(target.listPos, -1)
    const list = tr.doc.nodeAt(listPos)
    if (!list || !isListTypeName(list.type.name)) throw new Error('Drop list disappeared')
    const items = itemsOf(list)
    if (target.boundaryIndex <= 0 || target.boundaryIndex >= items.length) {
      throw new Error('Drop boundary is outside the list')
    }
    const before = listWithItems(list, items.slice(0, target.boundaryIndex))!
    const after = listWithItems(list, items.slice(target.boundaryIndex), target.boundaryIndex)!

    // An ordinary block dropped between list items becomes a new item of that
    // list. Splitting the list around it would break ordered-list numbering
    // and leave a bare paragraph between two lists.
    if (!sourceList) {
      const itemType = state.schema.nodes[itemTypeForList(list.type.name)]
      if (itemType && blocks.every((node) => node.type.name === 'paragraph')) {
        const merged = listWithItems(list, [
          ...items.slice(0, target.boundaryIndex),
          ...blocks.map((node) => itemType.create(null, node)),
          ...items.slice(target.boundaryIndex),
        ])!
        tr.replaceWith(listPos, listPos + list.nodeSize, merged)
        tr.setSelection(Selection.near(tr.doc.resolve(listPos + 1)))
        removeEmptyLists(tr)
        tr.setMeta(blockDragPluginKey, null)
        view.dispatch(tr.scrollIntoView())
        return true
      }
    }

    const middle = sourceList
      ? wrapDraggedItems(state, sourceList, blocks, sourceIndex)
      : null
    const replacement = middle ? [before, middle, after] : [before, ...blocks, after]
    const $list = tr.doc.resolve(listPos)
    if (!$list.parent.canReplace($list.index(), $list.index() + 1, Fragment.fromArray(replacement))) {
      throw new Error('Destination cannot contain the block')
    }
    tr.replaceWith(listPos, listPos + list.nodeSize, replacement)
    tr.setSelection(Selection.near(tr.doc.resolve(listPos + before.nodeSize + 1)))
    if (sourceListPos != null) {
      cleanupSourceList(
        tr,
        tr.mapping.map(sourceListPos, -1),
        sourceList?.childCount === drag.ranges.length,
      )
    }
    removeEmptyLists(tr)
    tr.setMeta(blockDragPluginKey, null)
    view.dispatch(tr.scrollIntoView())
    return true
  } catch {
    view.dispatch(state.tr.setMeta(blockDragPluginKey, null))
    return false
  }
}

function wrapDraggedItems(
  state: EditorView['state'],
  sourceList: PMNode,
  items: readonly PMNode[],
  index: number,
): PMNode {
  if (!isListTypeName(sourceList.type.name)) throw new Error('Source item has no list')
  const attrs = sourceList.type.name === 'orderedList'
    ? { ...sourceList.attrs, start: (Number(sourceList.attrs.start) || 1) + index }
    : sourceList.attrs
  return createListOfType(state.schema, sourceList.type.name, [...items], attrs)
}

function findSplitListTarget(
  view: EditorView,
  drag: BlockDragState,
  clientX: number,
  clientY: number,
): BlockDropTarget | null {
  const container = getContainingListContainer(view, clientY)
  if (!container || container.node.childCount < 2) return null
  if (isDraggedBlockPos(drag, container.pos)) return null
  const dom = view.nodeDOM(container.pos)
  if (!(dom instanceof HTMLElement)) return null
  const rect = dom.getBoundingClientRect()
  if (Number.isFinite(rect.left) && Number.isFinite(rect.right)
    && (clientX < rect.left - 48 || clientX > rect.right + 16)) return null

  let boundaryIndex = container.node.childCount
  let offset = 0
  for (let index = 0; index < container.node.childCount; index += 1) {
    const item = container.node.child(index)
    const itemPos = container.pos + 1 + offset
    // A <li> rect includes nested lists. Its leading paragraph gives a stable
    // boundary for the row itself, even when the item owns many descendants.
    const heading = view.nodeDOM(itemPos + 1)
    const itemDom = view.nodeDOM(itemPos)
    const anchor = heading instanceof HTMLElement ? heading : itemDom
    if (anchor instanceof HTMLElement) {
      const itemRect = anchor.getBoundingClientRect()
      if (clientY < itemRect.top + itemRect.height / 2) {
        boundaryIndex = index
        break
      }
    }
    offset += item.nodeSize
  }
  if (boundaryIndex <= 0 || boundaryIndex >= container.node.childCount) return null
  let boundaryOffset = 0
  for (let index = 0; index < boundaryIndex; index += 1) {
    boundaryOffset += container.node.child(index).nodeSize
  }
  const insertPos = container.pos + 1 + boundaryOffset
  return {
    insertPos,
    listPos: container.pos,
    listTypeName: container.node.type.name,
    createList: false,
    anchorPos: insertPos,
    anchorDepth: container.depth,
    desiredDepth: container.depth,
    side: 'before',
    splitList: { listPos: container.pos, boundaryIndex },
  }
}

function findInsertPos(view: EditorView, drag: BlockDragState, clientX: number, clientY: number): number | null {
  const blockPos = findInsertPosBySiblingRects(view, drag, clientY)
  if (blockPos != null) return blockPos

  const coords = view.posAtCoords({ left: clientX, top: clientY })
  if (!coords) return null
  const { doc } = view.state
  const $pos = doc.resolve(coords.pos)
  let parentDepth: number | null = null

  for (let depth = $pos.depth; depth >= 0; depth--) {
    const node = $pos.node(depth)
    const start = depth === 0 ? 0 : $pos.start(depth)
    if (node.type.name === drag.parentTypeName && start === drag.parentStart) {
      parentDepth = depth
      break
    }
  }
  if (parentDepth == null || parentDepth + 1 > $pos.depth) return null

  const childPos = $pos.before(parentDepth + 1)
  const child = doc.nodeAt(childPos)
  if (!child) return null
  const dom = view.nodeDOM(childPos)
  if (!(dom instanceof HTMLElement)) return childPos
  const rect = dom.getBoundingClientRect()
  return clientY > rect.top + rect.height / 2 ? childPos + child.nodeSize : childPos
}

function findInsertPosBySiblingRects(view: EditorView, drag: BlockDragState, clientY: number): number | null {
  const { doc } = view.state
  try {
    const $parentStart = doc.resolve(drag.parentStart)
    const parent = $parentStart.parent
    if (parent.type.name !== drag.parentTypeName) return null

    let offset = 0
    for (let index = 0; index < parent.childCount; index += 1) {
      const child = parent.child(index)
      const childPos = drag.parentStart + offset
      const dom = view.nodeDOM(childPos)
      if (dom instanceof HTMLElement) {
        const rect = dom.getBoundingClientRect()
        if (clientY < rect.top + rect.height / 2) return childPos
      }
      offset += child.nodeSize
    }
    return drag.parentStart + parent.content.size
  } catch {
    return null
  }
}

interface ListItemRecord {
  pos: number
  node: PMNode
  depth: number
  top: number
  bottom: number
}

interface TopLevelBlockRecord {
  pos: number
  node: PMNode
  top: number
  bottom: number
}

function findListDropTarget(view: EditorView, drag: BlockDragState, clientX: number, clientY: number): BlockDropTarget | null {
  const topLevelBlocks = getTopLevelBlockRecords(view)
  const listContainer = getContainingListContainer(view, clientY)

  // A pointer outside every rendered list is a root-level drop. This is the
  // path that allows a list item to land between two ordinary paragraphs.
  // The containing list may be nested in a blockquote or another block node;
  // it does not have to be a direct child of the document.
  if (!listContainer) {
    return resolveRootListDropTarget(drag, clientY, topLevelBlocks)
  }

  const records: ListItemRecord[] = []
  view.state.doc.descendants((node, pos) => {
    if (!LIST_ITEM_TYPES.has(node.type.name)) return true
    // The dragged items and every descendant item are one indivisible block.
    if (isDraggedBlockPos(drag, pos)) return true
    if (!isWithinList(view.state.doc, pos, listContainer.pos)) return true

    const dom = view.nodeDOM(pos)
    const item = dom instanceof HTMLElement
      ? (dom.matches('li') ? dom : dom.closest('li'))
      : null
    if (!(item instanceof HTMLElement)) return true

    const rect = item.getBoundingClientRect()
    records.push({
      pos,
      node,
      depth: getListItemDepth(view.state.doc, pos),
      top: rect.top,
      bottom: rect.bottom,
    })
    return true
  })

  if (records.length === 0) return null
  records.sort((a, b) => a.pos - b.pos)

  // Ancestor <li> rectangles include their child lists. Prefer the deepest
  // containing item so nested items have independent vertical drop targets.
  const containing = records
    .filter((record) => clientY >= record.top && clientY <= record.bottom)
    .sort((a, b) => b.depth - a.depth || (a.bottom - a.top) - (b.bottom - b.top))
  const anchor = containing[0] ?? findNearestListItem(records, clientY)
  if (!anchor) return null

  const side: 'before' | 'after' = clientY > anchor.top + (anchor.bottom - anchor.top) / 2
    ? 'after'
    : 'before'
  const nested = resolveNestedListDropTarget(view, drag, anchor, clientX)
  if (nested) return nested
  return resolveListDropTarget(view.state.doc, drag, anchor, side)
    ?? findSplitListTarget(view, drag, clientX, clientY)
}

function resolveNestedListDropTarget(
  view: EditorView,
  drag: BlockDragState,
  anchor: ListItemRecord,
  clientX: number,
): BlockDropTarget | null {
  if (drag.ranges.some((range) => (
    anchor.pos <= range.from && range.to <= anchor.pos + anchor.node.nodeSize
  ))) return null
  const contentDom = view.nodeDOM(anchor.pos + 1)
  if (!(contentDom instanceof HTMLElement)) return null
  const rect = contentDom.getBoundingClientRect()
  if (!Number.isFinite(rect.left) || clientX < rect.left + 24) return null
  if (!drag.sourceListTypeName || !isListTypeName(drag.sourceListTypeName)) return null
  const insertPos = anchor.pos + anchor.node.nodeSize - 1
  return {
    insertPos,
    listPos: -1,
    listTypeName: drag.sourceListTypeName,
    createList: false,
    anchorPos: anchor.pos,
    anchorDepth: anchor.depth,
    desiredDepth: anchor.depth + 1,
    side: 'after',
    nestList: { itemPos: anchor.pos },
  }
}

interface ListContainerRecord {
  pos: number
  node: PMNode
  depth: number
  top: number
  bottom: number
}

function getContainingListContainer(view: EditorView, clientY: number): ListContainerRecord | null {
  const records: ListContainerRecord[] = []
  view.state.doc.descendants((node, pos) => {
    if (!LIST_TYPES.has(node.type.name)) return true
    const dom = view.nodeDOM(pos)
    if (!(dom instanceof HTMLElement)) return true
    const rect = dom.getBoundingClientRect()
    if (clientY >= rect.top && clientY <= rect.bottom) {
      records.push({
        pos,
        node,
        depth: getListNestingDepth(view.state.doc, pos),
        top: rect.top,
        bottom: rect.bottom,
      })
    }
    return true
  })

  records.sort((a, b) => b.depth - a.depth || (a.bottom - a.top) - (b.bottom - b.top))
  return records[0] ?? null
}

function getTopLevelBlockRecords(view: EditorView): TopLevelBlockRecord[] {
  const records: TopLevelBlockRecord[] = []
  view.state.doc.forEach((node, offset) => {
    const dom = view.nodeDOM(offset)
    if (!(dom instanceof HTMLElement)) return
    const rect = dom.getBoundingClientRect()
    records.push({ pos: offset, node, top: rect.top, bottom: rect.bottom })
  })
  return records
}

function isWithinList(doc: PMNode, itemPos: number, listPos: number): boolean {
  try {
    const $item = doc.resolve(itemPos)
    for (let depth = 1; depth <= $item.depth; depth += 1) {
      if (LIST_TYPES.has($item.node(depth).type.name) && $item.before(depth) === listPos) return true
    }
  } catch {
    return false
  }
  return false
}

export function resolveRootListDropTarget(
  drag: Pick<DraggedBlockRange, 'sourceDepth' | 'sourceListTypeName'>,
  clientY: number,
  records: TopLevelBlockRecord[],
): BlockDropTarget | null {
  if (records.length === 0) return null

  let insertPos: number | null = null
  let anchorPos = records[0].pos
  let side: 'before' | 'after' = 'before'

  const containing = records.find((record) => clientY >= record.top && clientY <= record.bottom)
  if (containing) {
    anchorPos = containing.pos
    side = clientY > containing.top + (containing.bottom - containing.top) / 2 ? 'after' : 'before'
    insertPos = side === 'before' ? containing.pos : containing.pos + containing.node.nodeSize
  } else {
    const next = records.find((record) => clientY < record.top)
    if (next) {
      anchorPos = next.pos
      insertPos = next.pos
    } else {
      const previous = records[records.length - 1]
      anchorPos = previous.pos
      side = 'after'
      insertPos = previous.pos + previous.node.nodeSize
    }
  }

  if (insertPos == null) return null

  const listTypeName = drag.sourceListTypeName ?? 'bulletList'
  return {
    insertPos,
    listPos: -1,
    listTypeName,
    createList: true,
    anchorPos,
    anchorDepth: -1,
    desiredDepth: 0,
    side,
  }
}

function findNearestListItem(records: ListItemRecord[], clientY: number): ListItemRecord | null {
  let previous: ListItemRecord | null = null
  for (const record of records) {
    if (clientY < record.top) return previous ?? record
    previous = record
  }
  return previous
}

/** Resolve a list target from a visual anchor and the source item depth. */
export function resolveListDropTarget(
  doc: PMNode,
  drag: Pick<DraggedBlockRange, 'from' | 'to' | 'sourceDepth' | 'sourceListTypeName'>,
  anchor: Pick<ListItemRecord, 'pos' | 'depth'>,
  side: 'before' | 'after',
): BlockDropTarget | null {
  const anchorNode = doc.nodeAt(anchor.pos)
  if (!anchorNode || !LIST_ITEM_TYPES.has(anchorNode.type.name)) return null

  const desiredDepth = Math.min(drag.sourceDepth, anchor.depth + 1)
  const context = getListItemContext(doc, anchor.pos, anchorNode, anchor.depth)
  if (!context) return null

  // Walk upward when the desired child list does not exist. Root-level drops
  // may create one list wrapper; nested levels are never synthesized here.
  for (let depth = desiredDepth; depth >= 0; depth -= 1) {
    const candidate = getTargetAtDepth(context, depth, side, drag.sourceListTypeName)
    if (!candidate || !isCompatibleTargetList(candidate.listTypeName, drag.sourceListTypeName, anchorNode.type.name)) {
      continue
    }

    return {
      insertPos: candidate.insertPos,
      listPos: candidate.listPos,
      listTypeName: candidate.listTypeName,
      createList: false,
      anchorPos: anchor.pos,
      anchorDepth: anchor.depth,
      desiredDepth: depth,
      side,
    }
  }
  return null
}

interface ListItemContext {
  doc: PMNode
  anchor: { pos: number; node: PMNode; depth: number }
  ancestors: Array<{ pos: number; node: PMNode; depth: number }>
}

interface TargetAtDepth {
  listPos: number
  listTypeName: string
  insertPos: number
}

function getListItemContext(doc: PMNode, anchorPos: number, anchorNode: PMNode, anchorDepth: number): ListItemContext | null {
  try {
    const $anchor = doc.resolve(anchorPos)
    const ancestors: Array<{ pos: number; node: PMNode; depth: number }> = []
    for (let depth = 1; depth <= $anchor.depth; depth += 1) {
      const node = $anchor.node(depth)
      if (LIST_ITEM_TYPES.has(node.type.name)) {
        ancestors.push({ pos: $anchor.before(depth), node, depth: ancestors.length })
      }
    }
    return { doc, anchor: { pos: anchorPos, node: anchorNode, depth: anchorDepth }, ancestors }
  } catch {
    return null
  }
}

function getTargetAtDepth(
  context: ListItemContext,
  depth: number,
  side: 'before' | 'after',
  sourceListTypeName: string | null,
): TargetAtDepth | null {
  if (depth === context.anchor.depth + 1) {
    const childList = findChildList(context.anchor, sourceListTypeName)
    if (!childList) return null
    return {
      listPos: childList.pos,
      listTypeName: childList.node.type.name,
      insertPos: side === 'before' ? childList.pos + 1 : childList.pos + 1 + childList.node.content.size,
    }
  }

  const item = depth === context.anchor.depth ? context.anchor : context.ancestors[depth]
  if (!item) return null
  const parent = getParentList(context.doc, item.pos)
  if (!parent) return null
  return {
    listPos: parent.pos,
    listTypeName: parent.node.type.name,
    insertPos: side === 'before' ? item.pos : item.pos + item.node.nodeSize,
  }
}

function findChildList(
  item: { pos: number; node: PMNode },
  sourceListTypeName: string | null,
): { pos: number; node: PMNode } | null {
  let result: { pos: number; node: PMNode } | null = null
  item.node.forEach((child, offset) => {
    if (result || !LIST_TYPES.has(child.type.name)) return
    if (sourceListTypeName === 'taskList' && child.type.name !== 'taskList') return
    if (sourceListTypeName !== 'taskList' && child.type.name === 'taskList') return
    result = { pos: item.pos + 1 + offset, node: child }
  })
  return result
}

function getParentList(doc: PMNode, itemPos: number): { pos: number; node: PMNode } | null {
  try {
    const $item = doc.resolve(itemPos)
    return { pos: $item.before($item.depth), node: $item.parent }
  } catch {
    return null
  }
}

function isCompatibleTargetList(listTypeName: string, sourceListTypeName: string | null, sourceItemTypeName: string): boolean {
  if (sourceItemTypeName === 'taskItem' || sourceListTypeName === 'taskList') return listTypeName === 'taskList'
  return listTypeName === 'bulletList' || listTypeName === 'orderedList'
}

function getListNestingDepth(doc: PMNode, listPos: number): number {
  try {
    const $list = doc.resolve(listPos)
    let depth = 0
    for (let level = 1; level <= $list.depth; level += 1) {
      if (LIST_TYPES.has($list.node(level).type.name)) depth += 1
    }
    return depth
  } catch {
    return 0
  }
}

function getListItemDepth(doc: PMNode, itemPos: number): number {
  try {
    const $pos = doc.resolve(itemPos)
    let depth = 0
    for (let level = 1; level <= $pos.depth; level += 1) {
      if (LIST_ITEM_TYPES.has($pos.node(level).type.name)) depth += 1
    }
    return depth
  } catch {
    return 0
  }
}

function mapDropTarget(target: BlockDropTarget, mapping: { map: (pos: number, assoc?: number) => number }): BlockDropTarget {
  const columnTarget = target.columnTarget
    ? target.columnTarget.kind === 'new-column'
      ? {
          ...target.columnTarget,
          anchorPos: mapping.map(target.columnTarget.anchorPos, -1),
          columnsPos: target.columnTarget.columnsPos == null
            ? undefined
            : mapping.map(target.columnTarget.columnsPos, -1),
        }
      : {
          ...target.columnTarget,
          columnPos: mapping.map(target.columnTarget.columnPos, -1),
          insertPos: mapping.map(target.columnTarget.insertPos, -1),
        }
    : undefined
  return {
    ...target,
    insertPos: mapping.map(target.insertPos, -1),
    listPos: mapping.map(target.listPos, -1),
    anchorPos: mapping.map(target.anchorPos, -1),
    splitList: target.splitList
      ? { ...target.splitList, listPos: mapping.map(target.splitList.listPos, -1) }
      : undefined,
    nestList: target.nestList
      ? { itemPos: mapping.map(target.nestList.itemPos, -1) }
      : undefined,
    columnTarget,
  }
}

function isValidDropPos(view: EditorView, drag: BlockDragState, target: BlockDropTarget): boolean {
  const { insertPos } = target
  if (drag.ranges.some((range) => insertPos >= range.from && insertPos <= range.to)) return false
  const { doc } = view.state
  if (insertPos < 0 || insertPos > doc.content.size) return false
  const sourceNodes = draggedNodes(view.state, drag)
  if (sourceNodes.length === 0) return false

  try {
    const $insert = doc.resolve(insertPos)
    const insertionContent = LIST_TYPES.has($insert.parent.type.name)
      ? Fragment.fromArray(sourceNodes)
      : Fragment.fromArray(buildDraggedNodes(view.state, drag))
    if (target.nestList) {
      const parentItem = doc.nodeAt(target.nestList.itemPos)
      const $source = doc.resolve(drag.from)
      const sourceList = $source.parent
      if (!parentItem || !LIST_ITEM_TYPES.has(parentItem.type.name)
        || !sourceNodes.every((node) => LIST_ITEM_TYPES.has(node.type.name))
        || !isListTypeName(sourceList.type.name)) return false
      const updated = nestItemsInParent(view.state, parentItem, sourceList, sourceNodes, $source.index())
      const $item = doc.resolve(target.nestList.itemPos)
      return $item.parent.canReplace($item.index(), $item.index() + 1, Fragment.from(updated))
    }
    if (target.splitList) {
      const list = doc.nodeAt(target.splitList.listPos)
      if (!list || !LIST_TYPES.has(list.type.name)) return false
      const index = target.splitList.boundaryIndex
      if (index <= 0 || index >= list.childCount) return false
      const items = itemsOf(list)
      const before = listWithItems(list, items.slice(0, index))!
      const after = listWithItems(list, items.slice(index), index)!
      const middle = drag.isListItem
        ? wrapDraggedItems(view.state, doc.resolve(drag.from).parent, sourceNodes, doc.resolve(drag.from).index())
        : null
      const replacement = middle ? [before, middle, after] : [before, ...sourceNodes, after]
      const $list = doc.resolve(target.splitList.listPos)
      return $list.parent.canReplace($list.index(), $list.index() + 1, Fragment.fromArray(replacement))
    }
    if (drag.isListItem && target.createList) {
      if ($insert.depth !== 0) return false
      return $insert.parent.canReplace($insert.index(), $insert.index(), insertionContent)
    }
    if (drag.isListItem && !LIST_TYPES.has($insert.parent.type.name)) return false
    if (!drag.isListItem) {
      const sameParent = $insert.parent.type.name === drag.parentTypeName
        && $insert.start($insert.depth) === drag.parentStart
      // Columns are independent containers: a block may move from a column to
      // the document root and vice versa.
      const crossesColumn = $insert.parent.type.name === 'column'
        || drag.parentTypeName === 'column'
      if (!sameParent && !crossesColumn) return false
    }
    return $insert.parent.canReplace($insert.index(), $insert.index(), insertionContent)
  } catch {
    return false
  }
}

/** True when `pos` is inside any block that the gesture is moving. */
function isDraggedBlockPos(drag: Pick<BlockDragState, 'ranges'>, pos: number): boolean {
  return drag.ranges.some((range) => pos >= range.from && pos < range.to)
}

function mergeAdjacentRootLists(tr: Transaction, insertedPos: number): void {
  let currentPos = insertedPos
  let current = tr.doc.nodeAt(currentPos)
  if (!current || !LIST_TYPES.has(current.type.name)) return

  const previousPos = getPreviousSiblingPos(tr.doc, currentPos)
  const previous = previousPos == null ? null : tr.doc.nodeAt(previousPos)
  if (previousPos != null && canMergeListRuns(previous, current)) {
    tr.join(currentPos)
    currentPos = previousPos
    current = tr.doc.nodeAt(currentPos)
  }

  if (!current || !LIST_TYPES.has(current.type.name)) return
  const nextPos = currentPos + current.nodeSize
  const next = tr.doc.nodeAt(nextPos)
  if (canMergeListRuns(current, next)) tr.join(nextPos)
}

function getPreviousSiblingPos(doc: PMNode, pos: number): number | null {
  let previousPos: number | null = null
  doc.forEach((_node, offset) => {
    if (offset < pos) previousPos = offset
  })
  return previousPos
}

function cleanupSourceList(tr: Transaction, sourceListPos: number, sourceWasSingleton: boolean): void {
  if (!sourceWasSingleton) return
  const list = tr.doc.nodeAt(sourceListPos)
  if (!list || !LIST_TYPES.has(list.type.name)) return

  // Deleting the source list's only item can leave a schema-preserving
  // placeholder. An empty item that existed alongside the source is user data.
  if (list.childCount === 1 && isEmptyListItem(list.firstChild)) {
    tr.delete(sourceListPos, sourceListPos + list.nodeSize)
  }
}

function isEmptyListItem(node: PMNode | null): boolean {
  if (!node || !LIST_ITEM_TYPES.has(node.type.name) || node.childCount !== 1) return false
  const paragraph = node.firstChild
  return !!paragraph && paragraph.type.name === 'paragraph' && paragraph.content.size === 0
}

function removeEmptyLists(tr: { doc: PMNode; delete: (from: number, to: number) => unknown }): void {
  const emptyLists: number[] = []
  tr.doc.descendants((node, pos) => {
    if (LIST_TYPES.has(node.type.name) && node.childCount === 0) emptyLists.push(pos)
    return true
  })

  for (const pos of emptyLists.sort((a, b) => b - a)) {
    const node = tr.doc.nodeAt(pos)
    if (node && LIST_TYPES.has(node.type.name) && node.childCount === 0) tr.delete(pos, pos + node.nodeSize)
  }
}
