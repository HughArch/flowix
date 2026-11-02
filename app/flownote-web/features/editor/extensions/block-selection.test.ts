import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TextSelection } from 'prosemirror-state'

import {
  BlockSelectionExtension,
  clearBlockSelection,
  extendBlockSelection,
  getBlockSelection,
  resolveBlockDragTargets,
  toggleBlockSelection,
} from './block-selection'

function createEditor(content: unknown): { editor: Editor; element: HTMLElement } {
  const element = document.createElement('div')
  document.body.append(element)
  const editor = new Editor({
    element,
    extensions: [StarterKit, BlockSelectionExtension],
    content: content as never,
  })
  return { editor, element }
}

function blocks(editor: Editor) {
  const result: Array<{ pos: number; nodeSize: number; text: string }> = []
  editor.state.doc.forEach((node, offset) => {
    result.push({ pos: offset, nodeSize: node.nodeSize, text: node.textContent })
  })
  return result
}

function paragraphContent(texts: string[]) {
  return {
    type: 'doc',
    content: texts.map((text) => ({
      type: 'paragraph',
      content: [{ type: 'text', text }],
    })),
  }
}

describe('block selection', () => {
  let cleanup: (() => void) | null = null
  afterEach(() => {
    cleanup?.()
    cleanup = null
  })

  function mount(content: unknown) {
    const created = createEditor(content)
    cleanup = () => {
      created.editor.destroy()
      created.element.remove()
    }
    return created.editor
  }

  it('toggles blocks into and out of the selection', () => {
    const editor = mount(paragraphContent(['A', 'B', 'C']))
    const [a, b, c] = blocks(editor)

    toggleBlockSelection(editor, a)
    expect(getBlockSelection(editor.state)?.ranges).toEqual([{ from: a.pos, to: a.pos + a.nodeSize }])

    toggleBlockSelection(editor, c)
    expect(getBlockSelection(editor.state)?.ranges.map((range) => range.from))
      .toEqual([a.pos, c.pos])
    expect(getBlockSelection(editor.state)?.anchorPos).toBe(c.pos)

    toggleBlockSelection(editor, c)
    expect(getBlockSelection(editor.state)?.ranges.map((range) => range.from)).toEqual([a.pos])
    expect(getBlockSelection(editor.state)?.anchorPos).toBe(a.pos)

    toggleBlockSelection(editor, a)
    expect(getBlockSelection(editor.state)).toBeNull()
    expect(b.pos).toBeGreaterThan(a.pos)
  })

  it('extends from the anchor to the clicked block', () => {
    const editor = mount(paragraphContent(['A', 'B', 'C', 'D']))
    const [a, , c] = blocks(editor)

    toggleBlockSelection(editor, a)
    extendBlockSelection(editor, c)

    expect(getBlockSelection(editor.state)?.ranges.map((range) => range.from))
      .toEqual([a.pos, a.pos + a.nodeSize, c.pos])
    // The anchor stays on the first click so a later Shift-click re-plans
    // the run from the same origin.
    expect(getBlockSelection(editor.state)?.anchorPos).toBe(a.pos)
  })

  it('allows blocks from different containers in one set', () => {
    const editor = mount({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'A' }] },
        {
          type: 'bulletList',
          content: [{
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'B' }] }],
          }],
        },
      ],
    })
    const [a] = blocks(editor)
    const listItems: Array<{ pos: number; nodeSize: number }> = []
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'listItem') listItems.push({ pos, nodeSize: node.nodeSize })
      return true
    })
    const [listItem] = listItems
    if (!listItem) throw new Error('Missing list item')

    toggleBlockSelection(editor, a)
    toggleBlockSelection(editor, listItem)

    expect(getBlockSelection(editor.state)?.ranges.map((range) => range.from))
      .toEqual([a.pos, listItem.pos])
  })

  it('keeps the set when an internal transaction moves the editor selection', () => {
    const editor = mount(paragraphContent(['A', 'B']))
    const [a] = blocks(editor)

    toggleBlockSelection(editor, a)

    const $pos = editor.state.doc.resolve(1)
    editor.view.dispatch(editor.view.state.tr.setSelection(TextSelection.create(editor.state.doc, $pos.pos)))
    // Editor chrome (heading fold controls, node views, …) may move the
    // caret while the user builds a multi-block selection. Only an explicit
    // press in the body or Escape clears the set.
    expect(getBlockSelection(editor.state)?.ranges).toEqual([{ from: a.pos, to: a.pos + a.nodeSize }])
  })

  it('clears explicitly', () => {
    const editor = mount(paragraphContent(['A']))
    const [a] = blocks(editor)

    toggleBlockSelection(editor, a)
    clearBlockSelection(editor)
    expect(getBlockSelection(editor.state)).toBeNull()
  })

  it('drags the whole set only when the handle block is part of it', () => {
    const editor = mount(paragraphContent(['A', 'B', 'C']))
    const [a, b, c] = blocks(editor)

    toggleBlockSelection(editor, a)
    toggleBlockSelection(editor, c)

    expect(resolveBlockDragTargets(editor, a).map((target) => target.pos))
      .toEqual([a.pos, c.pos])
    expect(resolveBlockDragTargets(editor, b).map((target) => target.pos))
      .toEqual([b.pos])
    expect(resolveBlockDragTargets(editor, null)).toEqual([])
  })
})
