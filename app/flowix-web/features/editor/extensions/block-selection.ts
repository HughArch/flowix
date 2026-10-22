import { Extension, type Editor } from '@tiptap/core'
import type { Node as PMNode } from 'prosemirror-model'
import { Plugin, PluginKey, type EditorState } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'

/**
 * Multi-block selection for the drag handle.
 *
 * The editor's own Selection is owned by ProseMirror and represents text /
 * node selections. Dragging several blocks at once is a different concept:
 * the user picks blocks through the drag handle (Mod-click toggles one block,
 * Shift-click extends from an anchor) and then drags the whole set. Keeping
 * that in a dedicated plugin state means:
 *
 *   - it survives view updates without React bookkeeping,
 *   - positions are remapped through every transaction,
 *   - a real ProseMirror selection change (the user clicked into the body)
 *     clears it, so stale highlights never linger.
 */

export interface BlockSelectionRange {
  /** Open-token position of the selected block. */
  from: number
  /** End position (`from + node.nodeSize`). */
  to: number
}

export interface BlockSelectionState {
  /** Sorted, non-overlapping ranges; each range is one complete block. */
  ranges: BlockSelectionRange[]
  /** Block the next Shift-click extends from. */
  anchorPos: number | null
}

export interface BlockSelectionTarget {
  pos: number
  nodeSize: number
}

/** Parent container of a block, resolved from the block's open-token position. */
export interface BlockContainer {
  parent: PMNode
  /** Document position where the container's content starts. */
  parentStart: number
  parentTypeName: string
  /** Index of the block inside the container. */
  index: number
}

export const blockSelectionPluginKey = new PluginKey<BlockSelectionState | null>('blockSelection')

export const BlockSelectionExtension = Extension.create({
  name: 'blockSelection',

  addProseMirrorPlugins() {
    return [
      new Plugin<BlockSelectionState | null>({
        key: blockSelectionPluginKey,
        state: {
          init: () => null,
          apply(tr, value) {
            const meta = tr.getMeta(blockSelectionPluginKey) as BlockSelectionState | null | undefined
            if (meta !== undefined) return meta ? normalizeSelection(tr.doc, meta) : null
            if (!value || value.ranges.length === 0) return value ?? null

            if (tr.docChanged) {
              const ranges: BlockSelectionRange[] = []
              for (const range of value.ranges) {
                const from = tr.mapping.mapResult(range.from, 1)
                const to = tr.mapping.mapResult(range.to, -1)
                if (from.deletedAcross || to.deletedAcross || from.pos >= to.pos) continue
                ranges.push({ from: from.pos, to: to.pos })
              }
              if (ranges.length === 0) return null
              const anchor = value.anchorPos == null
                ? null
                : tr.mapping.mapResult(value.anchorPos, 1)
              return normalizeSelection(tr.doc, {
                ranges,
                anchorPos: anchor && !anchor.deletedAcross ? anchor.pos : null,
              })
            }

            // Selection changes are deliberately NOT a clearing signal here:
            // clicking a heading's fold control (or any other editor chrome)
            // can move the caret through an internal transaction while the
            // user is still building a block selection. The drag-context-menu
            // clears the set explicitly when the user presses in the body.
            return value
          },
        },
        props: {
          handleKeyDown(view, event) {
            if (event.key !== 'Escape') return false
            if (!blockSelectionPluginKey.getState(view.state)) return false
            view.dispatch(view.state.tr.setMeta(blockSelectionPluginKey, null))
            return true
          },
          decorations(state) {
            const selection = blockSelectionPluginKey.getState(state)
            if (!selection || selection.ranges.length === 0) return null
            return DecorationSet.create(
              state.doc,
              selection.ranges.map((range) => Decoration.node(range.from, range.to, {
                class: 'is-block-selected',
              })),
            )
          },
        },
      }),
    ]
  },
})

export function getBlockSelection(state: EditorState): BlockSelectionState | null {
  return blockSelectionPluginKey.getState(state) ?? null
}

export function isBlockSelected(state: EditorState, pos: number): boolean {
  const selection = getBlockSelection(state)
  return Boolean(selection?.ranges.some((range) => range.from === pos))
}

/** Replace the whole selection. Passing no ranges clears it. */
export function setBlockSelection(editor: Editor, ranges: BlockSelectionRange[], anchorPos: number | null): void {
  if (editor.isDestroyed) return
  editor.view.dispatch(editor.view.state.tr.setMeta(blockSelectionPluginKey, ranges.length === 0
    ? null
    : { ranges, anchorPos }))
}

export function clearBlockSelection(editor: Editor): void {
  if (editor.isDestroyed) return
  if (!blockSelectionPluginKey.getState(editor.state)) return
  editor.view.dispatch(editor.view.state.tr.setMeta(blockSelectionPluginKey, null))
}

/**
 * Mod-click on the handle: toggle one block in / out of the set.
 *
 * Blocks may come from different containers (a list item plus a heading, for
 * example). The drag layer moves list items as wrapped lists when the target
 * is outside a list, so mixed sets remain coherent.
 */
export function toggleBlockSelection(editor: Editor, block: BlockSelectionTarget): void {
  if (editor.isDestroyed) return
  const range = rangeForBlock(editor.state, block)
  if (!range) return
  const current = getBlockSelection(editor.state)
  const currentRanges = current?.ranges ?? []
  const alreadySelected = currentRanges.some((item) => item.from === range.from)

  const nextRanges = alreadySelected
    ? currentRanges.filter((item) => item.from !== range.from)
    : [...currentRanges, range]

  const anchor = alreadySelected
    ? nextRanges[nextRanges.length - 1]?.from ?? null
    : range.from
  setBlockSelection(editor, nextRanges, anchor)
}

/**
 * Shift-click on the handle: select every sibling block between the anchor
 * and the clicked block. Extending across containers restarts the set.
 */
export function extendBlockSelection(editor: Editor, block: BlockSelectionTarget): void {
  if (editor.isDestroyed) return
  const range = rangeForBlock(editor.state, block)
  if (!range) return
  const current = getBlockSelection(editor.state)
  const anchorPos = current?.anchorPos ?? null
  if (anchorPos == null || !sameParent(editor.state.doc, anchorPos, range.from)) {
    setBlockSelection(editor, [range], range.from)
    return
  }

  const siblings = siblingBlocks(editor.state.doc, range.from)
  const anchorIndex = siblings.findIndex((sibling) => sibling.from === anchorPos)
  const targetIndex = siblings.findIndex((sibling) => sibling.from === range.from)
  if (anchorIndex < 0 || targetIndex < 0) {
    setBlockSelection(editor, [range], range.from)
    return
  }
  const start = Math.min(anchorIndex, targetIndex)
  const end = Math.max(anchorIndex, targetIndex)
  setBlockSelection(editor, siblings.slice(start, end + 1), anchorPos)
}

/**
 * Blocks the drag gesture should move. A block that is part of a multi-block
 * selection drags the whole set; anything else drags alone.
 */
export function resolveBlockDragTargets(
  editor: Editor,
  block: BlockSelectionTarget | null,
): BlockSelectionTarget[] {
  if (!block) return []
  const state = editor.state
  const selection = getBlockSelection(state)
  if (!selection || selection.ranges.length < 2) return [block]
  const containsBlock = selection.ranges.some((range) => range.from === block.pos)
  if (!containsBlock) return [block]
  return selection.ranges.map((range) => ({
    pos: range.from,
    nodeSize: range.to - range.from,
  }))
}

/**
 * Resolve the container that owns the block starting at `pos`.
 *
 * `doc.resolve(pos)` alone is ambiguous on node boundaries — the resolver may
 * land inside the block or in the parent depending on the position. Resolving
 * `pos + 1` (always inside the block) and walking up to the node whose
 * `before(depth)` equals `pos` gives the block depth deterministically.
 */
export function resolveBlockContainer(doc: PMNode, pos: number): BlockContainer | null {
  if (pos < 0 || pos >= doc.content.size) return null
  try {
    const $pos = doc.resolve(pos + 1)
    for (let depth = $pos.depth; depth >= 1; depth -= 1) {
      if ($pos.before(depth) !== pos) continue
      const parentDepth = depth - 1
      return {
        parent: $pos.node(parentDepth),
        parentStart: parentDepth === 0 ? 0 : $pos.start(parentDepth),
        parentTypeName: $pos.node(parentDepth).type.name,
        index: $pos.index(parentDepth),
      }
    }
  } catch {
    return null
  }
  return null
}

function rangeForBlock(state: EditorState, block: BlockSelectionTarget): BlockSelectionRange | null {
  const node = state.doc.nodeAt(block.pos)
  if (!node) return null
  const to = block.pos + node.nodeSize
  if (to !== block.pos + block.nodeSize) return null
  return { from: block.pos, to }
}

function sameParent(doc: PMNode, a: number, b: number): boolean {
  const left = resolveBlockContainer(doc, a)
  const right = resolveBlockContainer(doc, b)
  if (!left || !right) return false
  return left.parent === right.parent
    && left.parentStart === right.parentStart
    && left.parentTypeName === right.parentTypeName
}

/** Every block sharing the container of `pos`, in document order. */
function siblingBlocks(doc: PMNode, pos: number): BlockSelectionRange[] {
  const container = resolveBlockContainer(doc, pos)
  if (!container) return []
  const ranges: BlockSelectionRange[] = []
  container.parent.forEach((node, offset) => {
    ranges.push({ from: container.parentStart + offset, to: container.parentStart + offset + node.nodeSize })
  })
  return ranges
}

/**
 * Drop ranges that no longer describe a complete node. Adjacent blocks stay
 * as separate ranges on purpose: each range is one movable block, and the
 * drag layer needs the individual positions even inside a contiguous run.
 */
function normalizeSelection(doc: PMNode, value: BlockSelectionState): BlockSelectionState | null {
  const ranges: BlockSelectionRange[] = []
  for (const range of [...value.ranges].sort((a, b) => a.from - b.from)) {
    const node = doc.nodeAt(range.from)
    if (!node) continue
    const to = range.from + node.nodeSize
    if (to !== range.to) continue
    if (ranges.some((previous) => previous.from === range.from)) continue
    ranges.push({ from: range.from, to })
  }
  if (ranges.length === 0) return null
  const anchorPos = value.anchorPos != null && ranges.some((range) => range.from === value.anchorPos)
    ? value.anchorPos
    : ranges[0].from
  return { ranges, anchorPos }
}
