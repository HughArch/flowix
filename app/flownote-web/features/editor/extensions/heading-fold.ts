import { Extension } from '@tiptap/core'
import type { Node as PMNode } from 'prosemirror-model'
import { Plugin, PluginKey, Selection, type EditorState, type Transaction } from 'prosemirror-state'
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view'

const HEADING_TYPE_NAME = 'heading'
const FOLD_TOGGLE_SELECTOR = '.heading-fold-toggle'
export const HEADING_FOLDED_CONTENT_CLASS = 'is-heading-folded-content'
const FOLDABLE_HEADING_CLASS = 'is-foldable-heading'
const FOLDED_HEADING_CLASS = 'is-heading-folded'

export interface HeadingFoldLabels {
  fold: string
  unfold: string
}

export interface HeadingFoldOptions {
  getLabels: () => HeadingFoldLabels
}

export interface HeadingRecord {
  pos: number
  /** Position immediately after the heading node. */
  end: number
  level: number
}

export interface FoldRange {
  headingPos: number
  level: number
  /** First folded block position. Equal to `headingEnd` when nothing follows. */
  start: number
  /** End of the folded range (exclusive). */
  end: number
}

export interface HeadingFoldState {
  /** Absolute heading position -> heading level at the time it was folded. */
  folded: Map<number, number>
  decorations: DecorationSet
}

type HeadingFoldMeta =
  | { type: 'toggle'; pos: number }
  | { type: 'unfold-positions'; positions: number[] }
  | { type: 'clear' }
  /** Rebuild decorations without changing fold state (e.g. language switch). */
  | { type: 'refresh' }

export const headingFoldPluginKey = new PluginKey<HeadingFoldState>('headingFold')

function headingLevel(node: PMNode): number {
  return Number(node.attrs.level) || 1
}

/** Collect heading nodes that are direct children of the document. */
export function collectTopLevelHeadings(doc: PMNode): HeadingRecord[] {
  const headings: HeadingRecord[] = []
  doc.forEach((node, pos) => {
    if (node.type.name !== HEADING_TYPE_NAME) return
    headings.push({
      pos,
      end: pos + node.nodeSize,
      level: headingLevel(node),
    })
  })
  return headings
}

/**
 * One pass over the heading list: each heading owns everything up to the next
 * heading at the same or a higher level (monotonic stack, O(n)).
 */
function computeRangesForRecords(
  doc: PMNode,
  headings: readonly HeadingRecord[],
): FoldRange[] {
  const ranges: FoldRange[] = headings.map((heading) => ({
    headingPos: heading.pos,
    level: heading.level,
    start: heading.end,
    end: doc.content.size,
  }))

  const stack: number[] = []
  for (let index = 0; index < headings.length; index += 1) {
    while (stack.length > 0) {
      const top = stack[stack.length - 1]
      if (headings[top].level < headings[index].level) break
      ranges[stack.pop()!].end = headings[index].pos
    }
    stack.push(index)
  }
  return ranges
}

function rangeAt(
  headings: readonly HeadingRecord[],
  ranges: readonly FoldRange[],
  headingPos: number,
): FoldRange | null {
  const index = headings.findIndex((heading) => heading.pos === headingPos)
  if (index < 0) return null
  return ranges[index] ?? null
}

/**
 * A heading owns every following block until the next heading of the same or a
 * higher level. Returns `null` when `headingPos` is not a top-level heading.
 */
export function computeHeadingRange(doc: PMNode, headingPos: number): FoldRange | null {
  const headings = collectTopLevelHeadings(doc)
  return rangeAt(headings, computeRangesForRecords(doc, headings), headingPos)
}

export function computeFoldRanges(
  doc: PMNode,
  folded: ReadonlyMap<number, number>,
): FoldRange[] {
  if (folded.size === 0) return []

  const headings = collectTopLevelHeadings(doc)
  const ranges = computeRangesForRecords(doc, headings)
  const indexByPos = new Map(headings.map((heading, index) => [heading.pos, index]))
  const result: FoldRange[] = []

  for (const pos of folded.keys()) {
    const index = indexByPos.get(pos)
    if (index === undefined) continue
    const range = ranges[index]
    if (range.end <= range.start) continue
    result.push(range)
  }
  return result
}

export function isPosInFoldRanges(ranges: readonly FoldRange[], pos: number): boolean {
  return ranges.some((range) => pos >= range.start && pos < range.end)
}

/**
 * The heading a caret position belongs to: the heading that contains the
 * position, or the closest preceding top-level heading.
 */
export function findHeadingForPos(doc: PMNode, pos: number): number | null {
  let candidate: number | null = null
  for (const heading of collectTopLevelHeadings(doc)) {
    if (heading.pos > pos) break
    candidate = heading.pos
    if (pos <= heading.end) return heading.pos
  }
  return candidate
}

/** Re-map folded headings after a document change and drop deleted headings. */
export function remapFoldState(
  tr: Transaction,
  folded: ReadonlyMap<number, number>,
): Map<number, number> {
  const next = new Map<number, number>()
  for (const [pos, level] of folded) {
    // assoc = 1 keeps the fold attached to the heading when content is
    // inserted exactly at the heading's start position.
    const mapped = tr.mapping.mapResult(pos, 1)
    if (mapped.deletedAcross) continue
    const node = tr.doc.nodeAt(mapped.pos)
    if (node?.type.name !== HEADING_TYPE_NAME) continue
    // A different level means the original heading is gone and another one
    // shifted into this position; the saved fold no longer describes it.
    if (headingLevel(node) !== level) continue
    next.set(mapped.pos, level)
  }
  return next
}

function applyFoldMeta(
  meta: HeadingFoldMeta,
  prev: ReadonlyMap<number, number>,
  state: EditorState,
): Map<number, number> {
  const next = new Map(prev)
  if (meta.type === 'refresh') return next
  if (meta.type === 'clear') return new Map()
  if (meta.type === 'toggle') {
    if (next.has(meta.pos)) {
      next.delete(meta.pos)
      return next
    }
    const node = state.doc.nodeAt(meta.pos)
    if (node?.type.name === HEADING_TYPE_NAME) next.set(meta.pos, headingLevel(node))
    return next
  }

  for (const pos of meta.positions) next.delete(pos)
  return next
}

function createFoldToggle(
  view: EditorView,
  headingPos: number,
  folded: boolean,
  getLabels: () => HeadingFoldLabels,
): HTMLElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'heading-fold-toggle'
  button.contentEditable = 'false'
  button.tabIndex = -1

  const labels = getLabels()
  button.setAttribute('aria-label', folded ? labels.unfold : labels.fold)
  button.setAttribute('aria-expanded', folded ? 'false' : 'true')
  button.dataset.folded = folded ? 'true' : 'false'

  // Keep ProseMirror from moving the caret when the toggle is pressed.
  button.addEventListener('mousedown', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    toggleHeadingFold(view, headingPos)
  })

  return button
}

function buildDecorations(
  state: EditorState,
  folded: ReadonlyMap<number, number>,
  getLabels: () => HeadingFoldLabels,
): DecorationSet {
  const { doc } = state
  const headings = collectTopLevelHeadings(doc)
  const ranges = computeRangesForRecords(doc, headings)
  const classesByPos = new Map<number, Set<string>>()
  const attrsByPos = new Map<number, Record<string, string>>()
  const nodeSizes = new Map<number, number>()
  const decorations: Decoration[] = []
  // Included in the widget key so a language switch rebuilds the button DOM
  // (and therefore its aria-label) instead of reusing the old node.
  const labelKey = getLabels().fold

  const addClass = (pos: number, name: string) => {
    let classes = classesByPos.get(pos)
    if (!classes) {
      classes = new Set()
      classesByPos.set(pos, classes)
    }
    classes.add(name)
  }

  headings.forEach((heading, index) => {
    const node = doc.nodeAt(heading.pos)
    if (!node) return
    nodeSizes.set(heading.pos, node.nodeSize)

    const isFolded = folded.has(heading.pos)
    addClass(heading.pos, FOLDABLE_HEADING_CLASS)
    if (isFolded) addClass(heading.pos, FOLDED_HEADING_CLASS)
    attrsByPos.set(heading.pos, { 'data-heading-folded': isFolded ? 'true' : 'false' })

    // A heading with no following content has nothing to fold.
    const range = ranges[index]
    if (!range || range.end <= range.start) return

    decorations.push(Decoration.widget(heading.pos + 1, (view) => (
      createFoldToggle(view, heading.pos, isFolded, getLabels)
    ), {
      side: -1,
      key: `heading-fold-${heading.pos}-${isFolded}-${labelKey}`,
    }))
  })

  const foldedRanges = computeFoldRanges(doc, folded)
  if (foldedRanges.length > 0) {
    doc.forEach((node, pos) => {
      if (!isPosInFoldRanges(foldedRanges, pos)) return
      nodeSizes.set(pos, node.nodeSize)
      addClass(pos, HEADING_FOLDED_CONTENT_CLASS)
    })
  }

  // Multiple decorations on the same node would overwrite each other's class
  // attribute, so merge every class per node before creating the decorations.
  for (const [pos, classes] of classesByPos) {
    const nodeSize = nodeSizes.get(pos)
    if (!nodeSize) continue
    decorations.push(Decoration.node(pos, pos + nodeSize, {
      class: [...classes].join(' '),
      ...(attrsByPos.get(pos) ?? {}),
    }))
  }

  return DecorationSet.create(doc, decorations)
}

function dispatchFoldMeta(view: EditorView, meta: HeadingFoldMeta): boolean {
  if (view.isDestroyed) return false
  const tr = view.state.tr.setMeta(headingFoldPluginKey, meta)
  tr.setMeta('addToHistory', false)
  view.dispatch(tr)
  return true
}

/** Fold or unfold the heading at `headingPos`. */
export function toggleHeadingFold(view: EditorView, headingPos: number): boolean {
  if (view.isDestroyed) return false
  const node = view.state.doc.nodeAt(headingPos)
  if (!node || node.type.name !== HEADING_TYPE_NAME) return false

  const foldState = headingFoldPluginKey.getState(view.state)
  const willFold = !foldState?.folded.has(headingPos)
  const toggleMeta: HeadingFoldMeta = { type: 'toggle', pos: headingPos }

  if (!willFold) return dispatchFoldMeta(view, toggleMeta)

  // Folding hides the content; move the caret out first so it never sits in a
  // `display: none` subtree.
  const range = computeHeadingRange(view.state.doc, headingPos)
  if (!range || range.end <= range.start) return false

  const { selection } = view.state
  const selectionIsHidden = selection.empty
    ? selection.from >= range.start && selection.from < range.end
    : selection.from < range.end && selection.to > range.start
  const tr = view.state.tr.setMeta(headingFoldPluginKey, toggleMeta)
  tr.setMeta('addToHistory', false)
  if (selectionIsHidden) {
    tr.setSelection(Selection.near(tr.doc.resolve(range.start), -1))
  }
  view.dispatch(tr)
  return true
}

/** Unfold every heading whose folded range contains `pos`. */
export function unfoldAtPos(view: EditorView, pos: number): boolean {
  if (view.isDestroyed) return false
  const foldState = headingFoldPluginKey.getState(view.state)
  if (!foldState || foldState.folded.size === 0) return false

  const positions = computeFoldRanges(view.state.doc, foldState.folded)
    .filter((range) => pos >= range.start && pos < range.end)
    .map((range) => range.headingPos)
  if (positions.length === 0) return false

  return dispatchFoldMeta(view, { type: 'unfold-positions', positions })
}

/** Unfold the ancestors of a rendered heading element before revealing it. */
export function unfoldAtDomElement(view: EditorView, element: HTMLElement): boolean {
  if (view.isDestroyed || !element.isConnected) return false
  try {
    return unfoldAtPos(view, view.posAtDOM(element, 0))
  } catch {
    return false
  }
}

/**
 * Drop every fold. Called when the whole document is replaced, where position
 * mapping could otherwise attach stale folds to unrelated headings.
 */
export function clearHeadingFolds(view: EditorView): void {
  if (view.isDestroyed) return
  const foldState = headingFoldPluginKey.getState(view.state)
  if (!foldState || foldState.folded.size === 0) return
  dispatchFoldMeta(view, { type: 'clear' })
}

export const HeadingFoldExtension = Extension.create<HeadingFoldOptions>({
  name: 'headingFold',

  addOptions() {
    return {
      getLabels: () => ({ fold: 'Fold heading', unfold: 'Unfold heading' }),
    }
  },

  addProseMirrorPlugins() {
    const { getLabels } = this.options

    return [
      new Plugin<HeadingFoldState>({
        key: headingFoldPluginKey,

        state: {
          init: (_config, state) => {
            const folded = new Map<number, number>()
            return { folded, decorations: buildDecorations(state, folded, getLabels) }
          },

          apply: (tr, value, _oldState, newState) => {
            const meta = tr.getMeta(headingFoldPluginKey) as HeadingFoldMeta | undefined
            if (!meta && !tr.docChanged) return value

            let folded = value.folded
            if (meta) folded = applyFoldMeta(meta, folded, newState)
            if (tr.docChanged) folded = remapFoldState(tr, folded)

            return { folded, decorations: buildDecorations(newState, folded, getLabels) }
          },
        },

        props: {
          decorations(state) {
            return headingFoldPluginKey.getState(state)?.decorations ?? null
          },

          handleDOMEvents: {
            mousedown(_view, event) {
              const target = event.target
              if (!(target instanceof Element)) return false
              if (!target.closest(FOLD_TOGGLE_SELECTOR)) return false
              // The button handles the actual toggle; stopping ProseMirror's
              // mousedown path keeps the caret where it was.
              event.preventDefault()
              return true
            },
          },
        },

        appendTransaction(transactions, _oldState, newState) {
          // Never react to our own fold/unfold transactions: a fold that moves
          // the caret to the range boundary would otherwise unfold itself in
          // the same dispatch.
          if (transactions.some((tr) => tr.getMeta(headingFoldPluginKey))) return null
          if (!transactions.some((tr) => tr.selectionSet || tr.docChanged)) return null

          const foldState = headingFoldPluginKey.getState(newState)
          if (!foldState || foldState.folded.size === 0) return null

          const { from, to } = newState.selection
          const positions = computeFoldRanges(newState.doc, foldState.folded)
            .filter((range) => from < range.end && to > range.start)
            .map((range) => range.headingPos)
          if (positions.length === 0) return null

          const tr = newState.tr.setMeta(headingFoldPluginKey, {
            type: 'unfold-positions',
            positions,
          } satisfies HeadingFoldMeta)
          tr.setMeta('addToHistory', false)
          return tr
        },
      }),
    ]
  },
})
