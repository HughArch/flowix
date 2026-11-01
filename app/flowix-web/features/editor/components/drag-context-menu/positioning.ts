import type { Editor } from '@tiptap/core'
import {
  getBlockInfoForInteraction,
  getFocusedAgentThreadCardInfo,
  type CurrentBlockInfo,
} from '@features/editor/components/drag-context-menu/block-info'
import { getYOffset, HANDLE_SIZE } from '@features/editor/components/drag-context-menu/style'

/**
 * Geometry: where should the drag handle sit on screen for the editor's
 * current selection? Pure function of editor state + DOM rects.
 *
 * The X axis is fixed (18px from the proseMirror container's left edge).
 * For headings and paragraphs, the Y axis follows ProseMirror's first
 * text-line coordinate so block padding is included. Other blocks retain the
 * visible-block-top plus per-type offset fallback (see ./style.ts).
 */

export interface HandlePosition {
  visible: true
  x: number
  y: number
  blockInfo: CurrentBlockInfo
}

export interface HandleHidden {
  visible: false
}

// Visible block ancestor selector. List items are handled explicitly below;
// the selector remains the fallback for ordinary blocks.
// `.ProseMirror-node` is the catch-all for node-view wrappers.
const BLOCK_SELECTOR =
  'p, h1, h2, h3, h4, h5, h6, ul, ol, table, .tableWrapper, blockquote, pre, .code-block-wrapper, .ProseMirror-node'

const HANDLE_X_OFFSET = 18

/** 抓手对齐方式: 桌面/父容器 = 左侧 gutter, 触屏行抓手 = 行尾。 */
export type HandleAlign = 'left' | 'right'

/**
 * 需要在左侧单独出「父容器抓手」的容器块。
 *
 * 这些容器在触屏上整块可被移动 (点击出元素菜单, 按住拖动 = 移动整体),
 * 与行尾抓手 (点击进多选) 是两套不同的交互, 所以容器左侧挂一枚独立的
 * 抓手, 而不是复用行尾那枚。
 */
export const PARENT_CONTAINER_TYPES = new Set([
  'columns',
  'bulletList',
  'orderedList',
  'blockquote',
  'callout',
  'toggle',
])

/**
 * A line-background band starts 12px left of its block, so the default handle
 * position (18–36px from the ProseMirror edge) lands half inside the fill.
 * Shift the handle into the gutter when the block carries a background so the
 * whole square stays outside the coloured band.
 */
export const LINE_BACKGROUND_HANDLE_SHIFT = 14

/**
 * 触屏行尾抓手距滚动容器右缘的净空。触屏正文右侧留白加宽到 2.75rem (44px),
 * 18px 的抓手/圆点居中其中 (inset 13px), 不挤也不压正文。
 */
export const RIGHT_HANDLE_INSET = 13

/**
 * 触屏父容器抓手距滚动容器左缘的净空。触屏正文左侧留白同步加宽到
 * 2.25rem (36px), 18px 抓手落在 13–31px 的留白带里, 不压正文与列表序号。
 */
export const LEFT_HANDLE_INSET = 13

/**
 * 分栏内行尾抓手距列右缘的净空。列内容在触屏下预留 26px 的右侧 padding,
 * 抓手落在预留带内, 既不会压到列内文字, 也不会和 `.flowix-columns-add`
 * (位于分栏容器右缘外 8–30px) 重叠。
 */
export const COLUMN_HANDLE_INSET = 4

/**
 * 分栏内父容器抓手距列左缘的净空。
 *
 * 非首列的 `.flowix-column-content` 有 18px 的 `padding-left`, 正好等于抓手
 * 宽度, 所以抓手贴列左缘放 (净空 0) 就整枚落在留白里, 不压列内文字, 也不会
 * 越到左列去。首列没有这层 padding, 用的是编辑器自己的 gutter。
 */
export const COLUMN_LEFT_HANDLE_INSET = 0

/** Whether this block paints a line-background band the handle must clear. */
export function blockHasLineBackground(
  typeName: string,
  dom: Pick<HTMLElement, 'matches' | 'querySelector'> | null | undefined,
): boolean {
  // Table cells and media never own a line band; a nested coloured paragraph
  // inside them must not drag the handle out of their own gutter.
  if (!dom || typeName === 'table' || typeName === 'image' || typeName === 'videoAttachment') {
    return false
  }
  if (dom.matches('[data-flowix-block-bg]')) return true
  // List items and blockquotes carry the colour on their inner paragraph.
  return Boolean(dom.querySelector('[data-flowix-block-bg]'))
}

/** Resolve the current handle position. Returns `{ visible: false }` when
 *  the editor has no usable focus / no resolvable block (callers typically
 *  use this to hide the handle entirely).
 *
 *  `fontSize` and `lineHeight` come from the user settings (Preferences →
 *  Format) and feed into `getYOffset` so the handle stays aligned with the
 *  first line of text when the user changes typography. They are passed
 *  in (not read from CSS variables) so the caller controls re-positioning
 *  via React effect deps. */
export function computeHandlePosition(
  editor: Editor,
  fontSize: number,
  lineHeight: number,
  requireFocus = true,
  preferredInfo?: CurrentBlockInfo | null,
  /** 触屏: 抓手挂行尾 (右缘), 而不是桌面风格的左侧 gutter。 */
  alignRight = false,
): HandlePosition | HandleHidden | null {
  const view = editor.view
  if (!view) return null

  // AgentThreadCard owns a nested ProseMirror composer. The outer editor is
  // intentionally blurred while the composer is active, but the card still
  // needs its block handle for moving the card itself.
  const focusedAgentThreadCard = getFocusedAgentThreadCardInfo(editor)
  if (requireFocus && !view.hasFocus() && !focusedAgentThreadCard && !preferredInfo) return null

  const editorDom = view.dom as HTMLElement
  const editorContent = editorDom.closest('.editor-content') as HTMLElement | null
  const info = preferredInfo ?? focusedAgentThreadCard ?? getBlockInfoForInteraction(editor)
  if (!info || !editorContent) return null

  // Anchor the handle on the visible block element. Table node DOM may be the
  // table itself or Tiptap's `.tableWrapper`; list item node DOM is the
  // rendered <li>. Resolve these before falling back to generic block ancestors.
  const domNode = getVisibleBlockElement(info)
  if (!domNode) return null

  const proseMirrorRect = view.dom.getBoundingClientRect()
  const contentRect = editorContent.getBoundingClientRect()
  const nodeRect = domNode.getBoundingClientRect()

  // The handle is absolutely positioned inside `.editor-content`, so both
  // axes must be expressed in that scroll container's content coordinates.
  // In particular, subtracting ProseMirror's top loses the height of any
  // non-ProseMirror header (the memo title) and shifts every handle upward.
  //
  // Blocks inside a column have no shared left gutter: anchoring them to the
  // ProseMirror edge would place the handle over the first column instead of
  // the block's own column. The first column keeps the editor's own gutter
  // (and no extra content padding); later columns reserve their own left
  // padding so the handle can sit near the column edge without covering text
  // or list markers.
  const columnElement = info.dom.closest('.flowix-column')
  const columnRect = columnElement?.getBoundingClientRect() ?? null
  const isFirstColumn = !!columnElement && !columnElement.previousElementSibling?.classList.contains('flowix-column')
  // 触屏模式抓手挂在行尾 (贴右缘、收进正文右侧 padding 带内), 永远不压正文。
  //
  // 分栏内的行必须按「所在列」的右缘定位, 不能用滚动容器的右缘: 否则两列
  // 里的每一行抓手都挤到整块的最右边, 第一列的行抓手会横穿第二列压在文字上,
  // 第二列的行抓手则与 `.flowix-columns-add` (分栏容器右缘外) 重叠。
  const x = alignRight
    ? columnRect
      ? columnRect.right - contentRect.left + editorContent.scrollLeft - HANDLE_SIZE - COLUMN_HANDLE_INSET
      : contentRect.width - HANDLE_SIZE - RIGHT_HANDLE_INSET
    : columnRect
      ? (isFirstColumn
          ? nodeContentX(proseMirrorRect.left, contentRect.left, editorContent.scrollLeft)
          : columnRect.left - contentRect.left + editorContent.scrollLeft - 8)
      : nodeContentX(proseMirrorRect.left, contentRect.left, editorContent.scrollLeft)
  // Columns reserve an 18px gutter for the handle and place the resize line
  // 12px outside the column edge. Later columns keep that fixed gutter; the
  // first column has the editor's wider padding, so a background band still
  // needs the same step-aside as the gutter-less layout.
  const xOffset = blockHasLineBackground(info.typeName, info.dom) && (!columnRect || isFirstColumn)
    ? LINE_BACKGROUND_HANDLE_SHIFT
    : 0
  const y = textBlockContentY(view, info, contentRect.top, editorContent.scrollTop) ??
    nodeContentY(
      nodeRect.top,
      contentRect.top,
      editorContent.scrollTop,
      getYOffset(info, fontSize, lineHeight),
    )

  return { visible: true, x: x - xOffset, y, blockInfo: info }
}

/**
 * 解析「包含该块的容器」。
 *
 * 触屏父容器抓手作用于「容器整体」, 所以取的是同一层里最外层的容器:
 * 例如 callout 里的列表项, 抓手对应的是 callout, 而不是列表 —— 否则列表
 * 抓手和 callout 抓手会同时出现, 用户分不清在拖谁。
 *
 * 边界是 doc 或 **column**: 分栏里的每一列是独立的排版单元, 列内 callout
 * 的抓手必须作用于「这一列里的 callout」。若继续往外走到 doc 的直接子节点
 * (`columns`), 点击左列 callout 的抓手会钉住并修改整行 (跨越所有列),
 * 表现为"选中的是整行, 属性调整作用到整行"。
 *
 * 块本身不在任何容器内 (顶层普通段落 / 标题 / 图片等) 时返回 null,
 * 表示不需要父容器抓手。
 */
export function resolveContainerBlock(
  editor: Editor,
  info: CurrentBlockInfo | null,
): CurrentBlockInfo | null {
  if (!info) return null
  const view = editor.view
  if (!view || view.isDestroyed) return null
  const { doc } = view.state
  if (info.pos < 0 || info.pos > doc.content.size) return null

  let $pos
  try {
    // `pos` 是 open token, `pos + 1` 一定落在块内部; 文档末尾的原子块没有
    // 内部位置, 退化到边界本身 (与 block-selection 的解析保持一致)。
    $pos = doc.resolve(Math.min(info.pos + 1, doc.content.size))
  } catch {
    return null
  }

  // 由内向外找第一个「父节点是 doc 或 column」的容器 = 本层最外层容器。
  //
  // 先确定所在列的深度: 列内的一切 (包括列内 callout 外层的 `columns`) 都
  // 不能越过这一层。否则点击左列 callout 的抓手会解析到 `columns`, 表现为
  // "选中的是整行, 属性调整作用到整行/整块分栏"。
  let columnDepth = -1
  for (let depth = $pos.depth; depth >= 1; depth -= 1) {
    if ($pos.node(depth).type.name === 'column') {
      columnDepth = depth
      break
    }
  }

  for (let depth = $pos.depth; depth >= 1; depth -= 1) {
    if (columnDepth >= 0 && depth <= columnDepth) break
    const node = $pos.node(depth)
    if (!PARENT_CONTAINER_TYPES.has(node.type.name)) continue
    const parentTypeName = depth === 1 ? null : $pos.node(depth - 1).type.name
    if (parentTypeName !== null && parentTypeName !== 'column') continue
    const pos = $pos.before(depth)
    const dom = view.nodeDOM(pos)
    if (!(dom instanceof HTMLElement)) continue
    return {
      node,
      typeName: node.type.name,
      attrs: node.attrs,
      pos,
      nodeSize: node.nodeSize,
      dom,
    }
  }
  return null
}

/**
 * 父容器抓手的位置: 正文左侧 gutter (与行尾抓手对称)。
 *
 * 用固定 gutter 而不是"容器左缘再往左": 嵌套容器 (callout 内的列表、引用内
 * 的段落) 左缘本来就已经缩进, 再往外挪会压到 callout 图标 / 列表序号。
 * 固定 gutter 保证任何层级都落在留白带里, 不压正文。
 *
 * 分栏是例外: 列内的容器抓手必须挂在「自己这一列」的左侧留白里。若仍用
 * 整个正文的左 gutter, 左列 callout 的抓手会跑到整块最左边 (视觉上像在
 * 选整行), 右列容器的抓手则会落到左列上, 点了作用到错的列。
 */
export function computeContainerHandlePosition(
  editor: Editor,
  info: CurrentBlockInfo | null,
): HandlePosition | null {
  const container = resolveContainerBlock(editor, info)
  if (!container) return null
  const view = editor.view
  const editorDom = view.dom as HTMLElement
  const editorContent = editorDom.closest('.editor-content') as HTMLElement | null
  if (!editorContent) return null

  const contentRect = editorContent.getBoundingClientRect()
  const nodeRect = container.dom.getBoundingClientRect()
  if (nodeRect.height === 0) return null

  // 列内容器: 落在该列自己的左侧留白。非首列的 `.flowix-column-content`
  // 有 18px 的 padding-left (正好一枚抓手宽), 抓手贴列左缘就整枚在留白里;
  // 首列没有这层 padding, 它的左留白就是编辑器自己的 gutter。
  const columnElement = container.dom.closest('.flowix-column')
  const columnRect = columnElement?.getBoundingClientRect() ?? null
  const isFirstColumn = !!columnElement
    && !columnElement.previousElementSibling?.classList.contains('flowix-column')
  const x = columnRect && !isFirstColumn
    ? columnRect.left - contentRect.left + editorContent.scrollLeft + COLUMN_LEFT_HANDLE_INSET
    : LEFT_HANDLE_INSET

  return {
    visible: true,
    x,
    y: nodeContentY(nodeRect.top, contentRect.top, editorContent.scrollTop, 5),
    blockInfo: container,
  }
}

export function nodeContentX(
  proseMirrorLeft: number,
  scrollContainerLeft: number,
  scrollLeft: number,
): number {
  return proseMirrorLeft - scrollContainerLeft + scrollLeft + HANDLE_X_OFFSET
}

export function nodeContentY(
  nodeTop: number,
  scrollContainerTop: number,
  scrollTop: number,
  visualOffset: number,
): number {
  return nodeTop - scrollContainerTop + scrollTop + visualOffset
}

/**
 * Resolve the first rendered text-line center for headings and paragraphs in
 * the same content coordinate system as the absolutely-positioned handle.
 *
 * `EditorView.coordsAtPos` includes the browser's actual block padding, font
 * metrics and line-height. Centering the handle in that caret rectangle keeps
 * it aligned with the first line across text styles without duplicating CSS
 * spacing in TypeScript. Empty blocks still have a valid position
 * (`info.pos + 1`), while malformed or stale selections are handled by
 * returning null and using the normal block-top fallback.
 */
export function textBlockContentY(
  view: Editor['view'],
  info: CurrentBlockInfo,
  scrollContainerTop: number,
  scrollTop: number,
): number | null {
  if (info.typeName !== 'heading' && info.typeName !== 'paragraph') return null

  try {
    const textCoords = view.coordsAtPos(info.pos + 1)
    const lineHeight = textCoords.bottom - textCoords.top
    const centerOffset = Math.max(0, (lineHeight - HANDLE_SIZE) / 2)
    return textCoords.top - scrollContainerTop + scrollTop + centerOffset
  } catch {
    // The view can be destroyed between selectionUpdate and the RAF callback.
    return null
  }
}

function getVisibleBlockElement(info: CurrentBlockInfo): HTMLElement | null {
  if (info.typeName === 'image' || info.typeName === 'videoAttachment') return info.dom
  if (info.typeName === 'agentThreadCard') return info.dom
  // The callout NodeView itself is the visible block; `closest` would walk up
  // past it because `.flowix-callout` is not in BLOCK_SELECTOR.
  if (info.typeName === 'callout') return info.dom
  // Same for a toggle: its NodeView is the visible container and the handle
  // must follow the whole block, not an ancestor.
  if (info.typeName === 'toggle') return info.dom

  if (info.typeName === 'table') {
    if (info.dom.matches('table, .tableWrapper')) return info.dom
    const table = info.dom.querySelector('table')
    if (table instanceof HTMLElement) return table
  }
  if (info.typeName === 'listItem' || info.typeName === 'taskItem') {
    if (info.dom.matches('li')) return info.dom
    const item = info.dom.querySelector('li')
    if (item instanceof HTMLElement) return item
  }
  if (info.typeName === 'codeBlock') {
    if (info.dom.classList.contains('code-block-wrapper')) return info.dom
    const wrapper = info.dom.closest('.code-block-wrapper')
    if (wrapper instanceof HTMLElement) return wrapper
  }
  return info.dom.closest?.(BLOCK_SELECTOR) as HTMLElement | null
}
