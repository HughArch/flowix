import { describe, expect, it } from 'vitest'
import { Schema } from 'prosemirror-model'
import { EditorState, type Transaction } from 'prosemirror-state'
import type { Editor } from '@tiptap/core'

import type { BlockSelectionRange } from '@features/editor/extensions/block-selection'
import {
  copyBlocksToClipboard,
  cutBlocksToClipboard,
  getInternalBlockClipboard,
  rangeForBlockAt,
  selectAllTopLevelBlocks,
} from './block-clipboard'

/**
 * 移动端块剪贴板的核心语义:
 *   - 复制/剪切按"整块"粒度序列化 (不是按文本选区);
 *   - 剪切删除时从后往前, 多块位置互不污染;
 *   - 内部剪贴板始终可用 (WebView 的 navigator.clipboard.read 不可靠)。
 * 这里用纯 ProseMirror schema 伪造 editor, 不引入 Tiptap 全家桶。
 */

function createSchema() {
  return new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { group: 'block', content: 'text*' },
      heading: { group: 'block', content: 'text*' },
      text: { group: 'inline' },
    },
  })
}

function createEditor(docContent: Array<[string, string]>) {
  const schema = createSchema()
  const nodes = docContent.map(([type, text]) =>
    schema.nodes[type].create(null, text ? schema.text(text) : null))
  const doc = schema.nodes.doc.create(null, nodes)
  const state = EditorState.create({ schema, doc })
  const dispatched: Transaction[] = []
  const editor = {
    state,
    schema,
    isDestroyed: false,
    view: {
      state,
      dispatch: (tr: Transaction) => { dispatched.push(tr) },
      nodeDOM: () => document.createElement('p'),
    },
  } as unknown as Editor
  return { editor, dispatched }
}

function topLevelRanges(editor: Editor): BlockSelectionRange[] {
  const ranges: BlockSelectionRange[] = []
  editor.state.doc.forEach((node, offset) => {
    ranges.push({ from: offset, to: offset + node.nodeSize })
  })
  return ranges
}

describe('block clipboard', () => {
  it('copies whole blocks into the internal clipboard as joined text', () => {
    const { editor } = createEditor([['paragraph', 'a'], ['paragraph', 'b'], ['paragraph', 'c']])
    const ranges = topLevelRanges(editor).slice(1)

    expect(copyBlocksToClipboard(editor, ranges)).toBe(true)
    expect(getInternalBlockClipboard()?.text).toBe('b\n\nc')
  })

  it('cuts selected blocks from back to front and clears the selection', () => {
    const { editor, dispatched } = createEditor([['paragraph', 'a'], ['paragraph', 'b'], ['heading', 'h']])
    const ranges = topLevelRanges(editor).slice(1)

    expect(cutBlocksToClipboard(editor, ranges)).toBe(true)
    expect(getInternalBlockClipboard()?.text).toBe('b\n\nh')

    // 第一次 dispatch 是删除事务, 第二次是清除块选中 (meta only, 文档不变)。
    const deleteTr = dispatched[0]!
    expect(deleteTr.doc.childCount).toBe(1)
    expect(deleteTr.doc.firstChild?.textContent).toBe('a')
    expect(dispatched[1]!.doc.childCount).toBe(3)
  })

  it('returns false when there is nothing to copy', () => {
    const { editor } = createEditor([['paragraph', 'a']])
    expect(copyBlocksToClipboard(editor, [])).toBe(false)
    expect(cutBlocksToClipboard(editor, [])).toBe(false)
  })

  it('selects every top-level block and keeps a per-block range helper', () => {
    const { editor } = createEditor([['paragraph', 'a'], ['paragraph', 'b'], ['paragraph', 'c']])

    const ranges = selectAllTopLevelBlocks(editor)
    expect(ranges).toHaveLength(3)
    expect(ranges[0]).toEqual(rangeForBlockAt(editor, 0))
  })

  it('returns null for positions without a block', () => {
    const { editor } = createEditor([['paragraph', 'a']])
    expect(rangeForBlockAt(editor, 999)).toBeNull()
  })
})
