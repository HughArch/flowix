import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { BlockSelectionExtension, getBlockSelection, setBlockSelection } from '@features/editor/extensions/block-selection'
import { moveSelectedBlocks } from './block-clipboard'

/**
 * 移动端"上移 / 下移"操作: 顶层块整体与相邻兄弟交换位置, 选中态保持在
 * 被移动的行上。用真实 Tiptap Editor + BlockSelectionExtension 驱动,
 * 走完整的 ProseMirror 事务路径。
 */

function createEditor(content: string): Editor {
  return new Editor({
    extensions: [Document, Paragraph, Text, BlockSelectionExtension],
    content,
  })
}

function topLevelTexts(editor: Editor): string[] {
  return [...editor.state.doc.children].map((node) => node.textContent)
}

describe('moveSelectedBlocks', () => {
  it('moves a single block up', () => {
    const editor = createEditor('<p>one</p><p>two</p><p>three</p>')
    setBlockSelection(editor, [{ from: 5, to: 10 }], 5)

    expect(moveSelectedBlocks(editor, -1)).toBe(true)
    expect(topLevelTexts(editor)).toEqual(['two', 'one', 'three'])
    editor.destroy()
  })

  it('moves a single block down', () => {
    const editor = createEditor('<p>one</p><p>two</p><p>three</p>')
    setBlockSelection(editor, [{ from: 5, to: 10 }], 5)

    expect(moveSelectedBlocks(editor, 1)).toBe(true)
    expect(topLevelTexts(editor)).toEqual(['one', 'three', 'two'])
    editor.destroy()
  })

  it('keeps the block selection on the moved rows', () => {
    const editor = createEditor('<p>one</p><p>two</p><p>three</p>')
    setBlockSelection(editor, [{ from: 5, to: 10 }], 5)
    moveSelectedBlocks(editor, -1)

    expect(topLevelTexts(editor)[0]).toBe('two')
    // 选中的块仍在选区里 (block-selection 插件按 docChanged 重映射)
    const selected = getBlockSelection(editor.state)
    expect(selected?.ranges).toHaveLength(1)
    const movedNode = editor.state.doc.nodeAt(selected!.ranges[0].from)
    expect(movedNode?.textContent).toBe('two')
    editor.destroy()
  })

  it('returns false at the boundary (cannot move further)', () => {
    const editor = createEditor('<p>one</p><p>two</p>')
    setBlockSelection(editor, [{ from: 0, to: 5 }], 0)

    expect(moveSelectedBlocks(editor, -1)).toBe(false)
    expect(topLevelTexts(editor)).toEqual(['one', 'two'])
    editor.destroy()
  })
})
