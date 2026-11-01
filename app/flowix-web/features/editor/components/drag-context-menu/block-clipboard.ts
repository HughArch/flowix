import type { Editor } from '@tiptap/core'
import { Fragment, DOMSerializer, type Node as PMNode } from 'prosemirror-model'
import {
  getBlockSelection,
  setBlockSelection,
  type BlockSelectionRange,
} from '@features/editor/extensions/block-selection'
import type { CurrentBlockInfo } from '@features/editor/components/drag-context-menu/block-info'

/**
 * 块级剪贴板 (移动端专用)。
 *
 * 移动端取消了"拖动块改变位置"和"长按弹菜单", 改成先选中若干行, 再在底部
 * 菜单里复制 / 剪切 / 粘贴。因此需要一份"按整块序列化"的能力:
 *
 *   - 序列化沿用编辑器自己的 Markdown 管线 (`editor.markdown.serialize`),
 *     所以粘贴回来时能还原标题 / 列表 / 表格等结构, 而不是只剩纯文本;
 *   - 系统剪贴板同时写入 text/plain 与 text/html (WebView 支持时), 外部
 *     应用粘贴也能拿到可读内容;
 *   - 模块内保留一份 `internalClipboard`, 因为 Android WebView 的
 *     `navigator.clipboard.read*` 经常不可用, 内部复制 / 粘贴仍要能闭环。
 */

export interface BlockClipboardPayload {
  markdown: string
  text: string
  html: string
}

let internalClipboard: BlockClipboardPayload | null = null

/** 仅供测试 / 调试读取当前内部剪贴板。 */
export function getInternalBlockClipboard(): BlockClipboardPayload | null {
  return internalClipboard
}

function nodesForRanges(editor: Editor, ranges: BlockSelectionRange[]): PMNode[] {
  const doc = editor.state.doc
  const nodes: PMNode[] = []
  for (const range of ranges) {
    const node = doc.nodeAt(range.from)
    if (!node) continue
    nodes.push(node)
  }
  return nodes
}

function serializeNodesToMarkdown(editor: Editor, nodes: PMNode[]): string {
  const json = { type: 'doc', content: nodes.map((node) => node.toJSON()) }
  try {
    const markdown = editor.markdown?.serialize(json)
    if (typeof markdown === 'string' && markdown.trim().length > 0) return markdown
  } catch {
    // 序列化失败时退化为纯文本, 至少不会让按钮点了没反应。
  }
  return nodes.map((node) => node.textContent).join('\n\n')
}

function serializeNodesToHtml(editor: Editor, nodes: PMNode[]): string {
  if (typeof document === 'undefined') return ''
  try {
    const serializer = DOMSerializer.fromSchema(editor.schema)
    const fragment = serializer.serializeFragment(Fragment.fromArray(nodes))
    const container = document.createElement('div')
    container.appendChild(fragment)
    return container.innerHTML
  } catch {
    return ''
  }
}

async function writeSystemClipboard(payload: BlockClipboardPayload): Promise<void> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
  if (!clipboard) return
  try {
    if (payload.html && typeof ClipboardItem !== 'undefined' && clipboard.write) {
      await clipboard.write([new ClipboardItem({
        'text/plain': new Blob([payload.text], { type: 'text/plain' }),
        'text/html': new Blob([payload.html], { type: 'text/html' }),
      })])
      return
    }
    await clipboard.writeText(payload.text)
  } catch {
    // 权限被拒 / WebView 不支持: 内部剪贴板仍然可用。
  }
}

/** 把若干整块写入内部 + 系统剪贴板。返回是否真的取到了内容。 */
export function copyBlocksToClipboard(editor: Editor, ranges: BlockSelectionRange[]): boolean {
  const nodes = nodesForRanges(editor, ranges)
  if (nodes.length === 0) return false
  const payload: BlockClipboardPayload = {
    markdown: serializeNodesToMarkdown(editor, nodes),
    text: nodes.map((node) => node.textContent).join('\n\n'),
    html: serializeNodesToHtml(editor, nodes),
  }
  internalClipboard = payload
  void writeSystemClipboard(payload)
  return true
}

/** 复制后删除。删除顺序从后往前, 避免前面的删除位移污染后面的位置。 */
export function cutBlocksToClipboard(editor: Editor, ranges: BlockSelectionRange[]): boolean {
  if (!copyBlocksToClipboard(editor, ranges)) return false
  if (editor.isDestroyed) return true
  const ordered = [...ranges].sort((a, b) => b.from - a.from)
  const tr = editor.state.tr
  for (const range of ordered) {
    const node = editor.state.doc.nodeAt(range.from)
    if (!node) continue
    tr.delete(range.from, range.from + node.nodeSize)
  }
  if (tr.docChanged) editor.view.dispatch(tr)
  setBlockSelection(editor, [], null)
  return true
}

/**
 * 把剪贴板内容插入到 `atPos` (默认当前光标处)。
 * 优先使用内部剪贴板里的 Markdown, 保证结构还原; 没有内部内容时退回
 * 系统剪贴板的纯文本。
 */
export async function pasteBlocksFromClipboard(editor: Editor, atPos?: number): Promise<boolean> {
  if (editor.isDestroyed) return false
  const pos = atPos ?? editor.state.selection.from
  let payload = internalClipboard
  if (!payload) {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
    const text = clipboard?.readText ? await clipboard.readText().catch(() => '') : ''
    if (!text) return false
    payload = { markdown: text, text, html: '' }
  }
  const content = payload.markdown.trim().length > 0 ? payload.markdown : payload.text
  if (!content.trim()) return false
  const inserted = editor.chain().focus().insertContentAt(pos, content, { contentType: 'markdown' }).run()
  if (!inserted) {
    // Markdown 解析失败时退回纯文本插入, 至少让文字落到文档里。
    editor.chain().focus().insertContentAt(pos, payload.text).run()
  }
  setBlockSelection(editor, [], null)
  return true
}

/** 选中文档里的所有顶层块。 */
export function selectAllTopLevelBlocks(editor: Editor): BlockSelectionRange[] {
  if (editor.isDestroyed) return []
  const ranges: BlockSelectionRange[] = []
  editor.state.doc.forEach((node, offset) => {
    ranges.push({ from: offset, to: offset + node.nodeSize })
  })
  setBlockSelection(editor, ranges, ranges[0]?.from ?? null)
  return ranges
}

/** 单个块的选中范围。 */
export function rangeForBlockAt(editor: Editor, pos: number): BlockSelectionRange | null {
  // nodeAt 对越界 pos 直接抛 RangeError, 这里先做边界检查而不是 try/catch,
  // 让"没有块"和"真的坏了"两种情况可区分。
  if (editor.isDestroyed) return null
  const doc = editor.state.doc
  if (pos < 0 || pos >= doc.content.size) return null
  const node = doc.nodeAt(pos)
  if (!node) return null
  return { from: pos, to: pos + node.nodeSize }
}

/**
 * 把选中的块整体上移 / 下移一行 (移动端没有拖拽换位, 这是替代手势)。
 *
 * 按顶层兄弟块粒度移动: 多选时移动整段连续跨度 (中间夹着的未选行会一起
 * 走, 与 Flowus 行为一致)。移动后块选中插件按 docChanged 自动重映射,
 * 选中状态保持在被移动的行上。
 */
export function moveSelectedBlocks(editor: Editor, direction: -1 | 1): boolean {
  if (editor.isDestroyed) return false
  const selection = getBlockSelection(editor.state)
  if (!selection || selection.ranges.length === 0) return false
  const doc = editor.state.doc
  const topLevel: Array<{ from: number; to: number; typeName: string }> = []
  doc.forEach((node, offset) => {
    topLevel.push({ from: offset, to: offset + node.nodeSize, typeName: node.type.name })
  })

  const first = selection.ranges[0]
  const last = selection.ranges[selection.ranges.length - 1]
  const firstIdx = topLevel.findIndex((t) => t.from === first.from)
  const lastIdx = topLevel.findIndex((t) => t.from === last.from)
  const targetIdx = direction === -1 ? firstIdx - 1 : lastIdx + 1
  if (firstIdx < 0 || lastIdx < 0) return false
  if (targetIdx < 0 || targetIdx >= topLevel.length) return false
  // frontmatter 固定在文档首位 (扩展的 appendTransaction 会把插到它前面的
  // 块挪回去), 上移撞到它就当作边界, 静默不动。
  if (direction === -1 && targetIdx === 0 && topLevel[0].typeName === 'frontmatter') {
    return false
  }

  const from = first.from
  const to = last.to
  const nodes = nodesForRanges(editor, selection.ranges)
  if (nodes.length === 0) return false

  const tr = editor.state.tr
  tr.delete(from, to)
  const spanSize = to - from
  // 上移: 落到前一个兄弟原来的起点 (它前面的位置不受删除影响)。
  // 下移: 落到后一个兄弟的终点之后 ── 删除后它整体左移 spanSize,
  // 所以是 next.to - spanSize (即删除后文档里"最后一个被让位块的末尾")。
  const insertAt = direction === -1
    ? topLevel[targetIdx].from
    : topLevel[targetIdx].to - spanSize
  tr.insert(insertAt, Fragment.fromArray(nodes))
  editor.view.dispatch(tr)

  // 删除+插入的组合会让插件重映射出的区间退化 (from===to) 而被丢弃,
  // 这里按新位置显式重建选中态, 让连续上移/下移不打断。
  const moved: BlockSelectionRange[] = []
  let cursor = insertAt
  for (const node of nodes) {
    moved.push({ from: cursor, to: cursor + node.nodeSize })
    cursor += node.nodeSize
  }
  setBlockSelection(editor, moved, moved[0]?.from ?? null)
  return true
}

/**
 * 从选中范围还原完整的块信息。
 *
 * 底部 "更多操作" 弹层的菜单项都锚定在 `CurrentBlockInfo` 上 (背景色 /
 * 分栏 / 插入行都要 pos + dom), 而块选中态只存了 from/to, 这里补上桥。
 */
export function blockInfoForPos(editor: Editor, pos: number): CurrentBlockInfo | null {
  if (editor.isDestroyed) return null
  const node = editor.state.doc.nodeAt(pos)
  if (!node) return null
  const dom = editor.view.nodeDOM(pos)
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
