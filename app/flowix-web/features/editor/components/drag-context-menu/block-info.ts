import type { Editor } from '@tiptap/core'
import type { Node as PMNode } from 'prosemirror-model'
import { NodeSelection } from 'prosemirror-state'

/**
 * Pure ProseMirror-native helper for resolving the "block" the cursor
 * (or a NodeSelection) is currently on. Deterministic given editor state —
 * no React, no DOM mutation, no class manipulation. It is the data layer the
 * drag-context-menu component sits on top of.
 *
 * Naming: `pos` is the open-token position of the node; `nodeSize` is
 * `node.nodeSize` (includes the open and close tokens); `from` / `to`
 * for TextSelection sit just inside the open / close respectively.
 */

export interface CurrentBlockInfo {
  /** The ProseMirror node the user is currently focused on or has selected. */
  node: PMNode
  /** The schema-level name string (e.g. 'heading', 'paragraph', 'image'). */
  typeName: string
  /** The node's attributes (e.g. { level: 2 } for a heading). */
  attrs: Record<string, unknown>
  /** Open-token position of the node in the document. */
  pos: number
  /** Total byte size of the node, for `deleteRange`. */
  nodeSize: number
  /**
   * Outer DOM for the node (from `view.nodeDOM(pos)`), suitable for
   * `getBoundingClientRect` and visual anchoring. Callers may walk up
   * via `closest` to reach a visible block ancestor when desired.
   */
  dom: HTMLElement
}

const LIST_ITEM_TYPES = new Set(['listItem', 'taskItem'])

/** Resolve the block the editor's current selection is on (PM-native, not DOM). */
export function getCurrentBlockInfo(editor: Editor): CurrentBlockInfo | null {
  const view = editor.view
  if (!view) return null
  const { selection } = view.state

  // NodeSelection: the selected node IS the block the user means
  // (e.g. freshly uploaded file attachments).
  if (selection instanceof NodeSelection) {
    const node = selection.node
    const dom = view.nodeDOM(selection.from)
    if (!(dom instanceof HTMLElement)) return null
    return {
      node,
      typeName: node.type.name,
      attrs: node.attrs,
      pos: selection.from,
      nodeSize: node.nodeSize,
      dom,
    }
  }

  // TextSelection / cursor: use the nearest wrapping block when the cursor
  // is inside one. This keeps the handle's visual anchor and the command /
  // drag target aligned for lists, tables, and quotes.
  // Plain text blocks (paragraph, heading, codeBlock, etc.) fall back to the
  // immediate parent.
  const { $from } = selection
  if ($from.depth < 1) return null
  const depth = getTargetBlockDepth($from)
  const node = $from.node(depth)
  const pos = $from.before(depth)
  const dom = view.nodeDOM(pos)
  if (!(dom instanceof HTMLElement)) return null
  return {
    node,
    typeName: node.type.name,
    attrs: node.attrs,
    pos,
    nodeSize: node.nodeSize,
    dom,
  }
}

/**
 * Resolve an AgentThreadCard whose nested composer currently owns focus.
 *
 * The composer is a second ProseMirror editor mounted inside the card's
 * NodeView. In that state the outer editor selection is deliberately cleared
 * (so the card does not remain NodeSelected), which means
 * `getCurrentBlockInfo()` can no longer describe the card. Match the live
 * NodeView DOM back to the document instead of relying on the outer selection.
 */
export function getFocusedAgentThreadCardInfo(editor: Editor): CurrentBlockInfo | null {
  if (editor.isDestroyed) return null

  const view = editor.view
  if (!view || view.isDestroyed) return null

  const activeElement = view.dom.ownerDocument.activeElement
  if (!(activeElement instanceof HTMLElement)) return null

  const composer = activeElement.closest<HTMLElement>('.agent-composer')
  if (!composer || !view.dom.contains(composer)) return null

  const card = composer.closest<HTMLElement>('[data-agent-thread-card="true"]')
  if (!card || !view.dom.contains(card)) return null

  let result: CurrentBlockInfo | null = null
  view.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'agentThreadCard') return true
    if (view.nodeDOM(pos) !== card) return true

    result = {
      node,
      typeName: node.type.name,
      attrs: node.attrs,
      pos,
      nodeSize: node.nodeSize,
      dom: card,
    }
    return false
  })

  return result
}

const CALLOUT_CONTENT_SELECTOR = ':scope > .flowix-callout-content'
const INNER_BLOCK_SELECTOR =
  'p, h1, h2, h3, h4, h5, h6, ul, ol, li, table, .tableWrapper, blockquote, pre, .code-block-wrapper, .ProseMirror-node'

/**
 * Resolve the block under a pointer position. Used by the drag handle to
 * follow the mouse, so block selection does not require focusing (and thereby
 * replacing) the editor selection first.
 *
 * Two paths on purpose: `posAtCoords` understands document semantics
 * (list items, tables) but can miss blocks whose DOM is not laid out the way
 * ProseMirror expects. Falling back to the DOM element under the pointer keeps
 * ordinary paragraphs hoverable.
 */
export function getBlockInfoAtCoords(
  editor: Editor,
  clientX: number,
  clientY: number,
): CurrentBlockInfo | null {
  const view = editor.view
  if (!view || view.isDestroyed) return null

  // Callouts expose two drag units: the container (icon rail / padding) and
  // each inner block (text rows). Resolve that distinction from the DOM before
  // `posAtCoords`, which would otherwise always pick one of the inner blocks.
  const calloutInfo = calloutBlockInfoAtCoords(view, clientX, clientY)
  if (calloutInfo !== undefined) return calloutInfo

  // Columns need the same treatment: in a column's left gutter `posAtCoords`
  // resolves to the `columns` / `column` container, which has no visible block
  // and therefore no handle. Resolving the row from the DOM keeps the handle
  // stable no matter which side the pointer enters from.
  const columnInfo = columnBlockInfoAtCoords(view, clientX, clientY)
  if (columnInfo !== undefined) return columnInfo

  const coordsInfo = blockInfoFromCoords(view, clientX, clientY)
  if (coordsInfo && !isLayoutContainer(coordsInfo.typeName)) return coordsInfo
  return blockInfoFromDom(view, clientX, clientY)
}

/** Containers that group blocks but never own a drag handle themselves. */
function isLayoutContainer(typeName: string): boolean {
  return typeName === 'columns' || typeName === 'column'
}

function columnBlockInfoAtCoords(
  view: Editor['view'],
  clientX: number,
  clientY: number,
): CurrentBlockInfo | null | undefined {
  const element = document.elementFromPoint(clientX, clientY)
  if (!(element instanceof Element) || !view.dom.contains(element)) return undefined

  const column = element.closest<HTMLElement>('.flowix-column')
  if (!column || !view.dom.contains(column)) return undefined

  const inner = element.closest<HTMLElement>(INNER_BLOCK_SELECTOR)
  if (inner && column.contains(inner)) {
    const info = blockInfoFromNodeElement(view, inner)
    if (info && !isLayoutContainer(info.typeName)) return info
  }

  // Pointer on the column's gutter/padding: pick the row under Y.
  return blockInfoFromColumn(view, column, clientY) ?? undefined
}

function blockInfoFromNodeElement(
  view: Editor['view'],
  element: HTMLElement,
): CurrentBlockInfo | null {
  try {
    return blockInfoAtPosition(view, view.posAtDOM(element, 0))
  } catch {
    return null
  }
}

function nearestChildAtY(container: HTMLElement, clientY: number): HTMLElement | null {
  let best: HTMLElement | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const child of Array.from(container.children)) {
    if (!(child instanceof HTMLElement)) continue
    const rect = child.getBoundingClientRect()
    const distance = clientY < rect.top
      ? rect.top - clientY
      : clientY > rect.bottom
        ? clientY - rect.bottom
        : 0
    if (distance < bestDistance) {
      bestDistance = distance
      best = child
    }
  }
  return best
}

/**
 * `undefined` means "no callout under the pointer, use the generic resolver".
 * A returned value (including null) is authoritative for callout hits.
 */
function calloutBlockInfoAtCoords(
  view: Editor['view'],
  clientX: number,
  clientY: number,
): CurrentBlockInfo | null | undefined {
  const element = document.elementFromPoint(clientX, clientY)
  if (!(element instanceof Element) || !view.dom.contains(element)) return undefined

  const callout = element.closest<HTMLElement>('.flowix-callout')
  if (!callout || !view.dom.contains(callout)) return undefined

  const content = callout.querySelector<HTMLElement>(CALLOUT_CONTENT_SELECTOR)
  if (!content) {
    return blockInfoFromNodeElement(view, callout) ?? undefined
  }

  // The icon rail is the explicit container handle, independent of Y.
  const icon = callout.querySelector<HTMLElement>(':scope > .flowix-callout-icon')
  if (icon && icon.contains(element)) {
    return blockInfoFromNodeElement(view, callout) ?? undefined
  }

  // Above/below the content band (the callout's vertical padding) selects the
  // container. This is what lets a left-to-right approach pick up the row
  // handle as soon as the pointer enters the content band, instead of being
  // captured by the padding and shown at the container's top edge.
  const contentRect = content.getBoundingClientRect()
  if (clientY < contentRect.top || clientY > contentRect.bottom) {
    return blockInfoFromNodeElement(view, callout) ?? undefined
  }

  // Inside the content band the hovered block owns the handle. This keeps
  // rows, list items and nested columns individually draggable while the
  // container stays reachable from the icon rail and the vertical padding.
  const inner = element.closest<HTMLElement>(INNER_BLOCK_SELECTOR)
  if (inner && content.contains(inner)) {
    const info = blockInfoFromNodeElement(view, inner)
    if (info) return info
  }

  // Column gutters / padding inside a callout keep the column resolution so
  // the handle does not collapse onto the `columns` container itself.
  const column = element.closest<HTMLElement>('.flowix-column')
  if (column && content.contains(column)) {
    const info = blockInfoFromColumn(view, column, clientY)
    if (info) return info
  }

  // The pointer can be over the callout's horizontal padding (outside the
  // content DOM) while still on a content row. Resolve that row by Y so the
  // handle does not depend on entering from a particular side.
  const nearest = nearestChildAtY(content, clientY)
  if (nearest) {
    const nestedColumn = nearest.querySelector<HTMLElement>('.flowix-column')
    if (nestedColumn) {
      const info = blockInfoFromColumn(view, nestedColumn, clientY)
      if (info) return info
    }
    const info = blockInfoFromNodeElement(view, nearest)
    if (info) return info
  }

  return blockInfoFromNodeElement(view, callout) ?? undefined
}

function blockInfoFromCoords(
  view: Editor['view'],
  clientX: number,
  clientY: number,
): CurrentBlockInfo | null {
  let coords: { pos: number; inside: number } | null = null
  try {
    coords = view.posAtCoords({ left: clientX, top: clientY })
  } catch {
    return null
  }
  if (!coords) return null

  // `inside` prefers an enclosing node (images, tables, cards); otherwise
  // resolve the text position itself.
  const anchor = coords.inside >= 0 ? coords.inside + 1 : coords.pos
  return blockInfoAtPosition(view, anchor)
}

function blockInfoFromDom(
  view: Editor['view'],
  clientX: number,
  clientY: number,
): CurrentBlockInfo | null {
  const element = document.elementFromPoint(clientX, clientY)
  if (!(element instanceof HTMLElement) || !view.dom.contains(element)) return null

  // Keep the same drag unit as `getTargetBlockDepth`: tables win over list
  // items, list items win over their paragraphs.
  const block = element.closest<HTMLElement>('table')
    ?? element.closest<HTMLElement>('li')
    ?? element.closest<HTMLElement>('p, h1, h2, h3, h4, h5, h6, blockquote, pre, .code-block-wrapper, .ProseMirror-node')
  if (!block || !view.dom.contains(block)) {
    // The pointer can sit in a column's left gutter (where its drag handle
    // lives) without being inside any block. Resolve the nearest block in that
    // column so the handle survives the trip from the block to itself.
    const column = element.closest<HTMLElement>('.flowix-column')
    if (column && view.dom.contains(column)) {
      return blockInfoFromColumn(view, column, clientY)
    }
    return null
  }

  try {
    return blockInfoAtPosition(view, view.posAtDOM(block, 0))
  } catch {
    return null
  }
}

function blockInfoFromColumn(
  view: Editor['view'],
  column: HTMLElement,
  clientY: number,
): CurrentBlockInfo | null {
  const content = column.querySelector<HTMLElement>(':scope > .flowix-column-content')
  if (!content) return null

  let best: HTMLElement | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const child of Array.from(content.children)) {
    if (!(child instanceof HTMLElement)) continue
    const rect = child.getBoundingClientRect()
    const distance = clientY < rect.top
      ? rect.top - clientY
      : clientY > rect.bottom
        ? clientY - rect.bottom
        : 0
    if (distance < bestDistance) {
      bestDistance = distance
      best = child
    }
  }
  if (!best) return null

  try {
    return blockInfoAtPosition(view, view.posAtDOM(best, 0))
  } catch {
    return null
  }
}

function blockInfoAtPosition(view: Editor['view'], anchor: number): CurrentBlockInfo | null {
  try {
    const doc = view.state.doc
    const clamped = Math.min(Math.max(anchor, 0), doc.content.size)
    let $pos = doc.resolve(clamped)
    if ($pos.depth < 1) {
      // At a node boundary the resolver can land in the container; step into
      // the node that starts here.
      if (clamped >= doc.content.size) return null
      $pos = doc.resolve(clamped + 1)
      if ($pos.depth < 1) return null
    }
    const depth = getTargetBlockDepth($pos)
    const node = $pos.node(depth)
    const pos = $pos.before(depth)
    const dom = view.nodeDOM(pos)
    if (!(dom instanceof HTMLElement)) return null
    return {
      node,
      typeName: node.type.name,
      attrs: node.attrs,
      pos,
      nodeSize: node.nodeSize,
      dom,
    }
  } catch {
    return null
  }
}

function isCurrentBlockInfo(editor: Editor, info: CurrentBlockInfo): boolean {
  if (editor.isDestroyed || editor.view.isDestroyed) return false

  const { doc } = editor.view.state
  const node = doc.nodeAt(info.pos)
  return !!(
    node &&
    node.type.name === info.typeName &&
    node.nodeSize === info.nodeSize &&
    editor.view.nodeDOM(info.pos) === info.dom
  )
}

/** Resolve the block that should own the next drag-handle interaction. */
export function getBlockInfoForInteraction(
  editor: Editor,
  preferredInfo?: CurrentBlockInfo | null,
): CurrentBlockInfo | null {
  if (preferredInfo && isCurrentBlockInfo(editor, preferredInfo)) return preferredInfo
  return getFocusedAgentThreadCardInfo(editor) ?? getCurrentBlockInfo(editor)
}

/**
 * Re-activate the AgentThreadCard after the menu has locked its explicit
 * interaction target. The nested composer intentionally leaves the outer
 * editor selection on the previous text block, so relying on that selection
 * would target the wrong block.
 */
export function activateAgentThreadCard(
  editor: Editor,
  info: CurrentBlockInfo | null,
): boolean {
  if (editor.isDestroyed || !info || info.typeName !== 'agentThreadCard') return false

  const view = editor.view
  if (!view || view.isDestroyed) return false

  const node = view.state.doc.nodeAt(info.pos)
  if (
    !node ||
    node.type.name !== 'agentThreadCard' ||
    node.nodeSize !== info.nodeSize ||
    view.nodeDOM(info.pos) !== info.dom
  ) {
    return false
  }

  const { selection } = view.state
  if (selection instanceof NodeSelection && selection.from === info.pos) return true

  try {
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, info.pos)))
    return true
  } catch {
    return false
  }
}

function getTargetBlockDepth($from: { depth: number; node: (depth: number) => PMNode }): number {
  for (let depth = $from.depth; depth >= 1; depth--) {
    if ($from.node(depth).type.name === 'table') {
      return depth
    }
  }

  // A list item is the editable/dragged unit. Walk outwards from the
  // selection so a nested item wins over each of its ancestor items.
  for (let depth = $from.depth; depth >= 1; depth--) {
    if (LIST_ITEM_TYPES.has($from.node(depth).type.name)) {
      return depth
    }
  }

  return $from.depth
}
