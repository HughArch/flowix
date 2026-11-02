import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import type { JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import {
  HeadingFoldExtension,
  clearHeadingFolds,
  collectTopLevelHeadings,
  computeFoldRanges,
  computeHeadingRange,
  findHeadingForPos,
  headingFoldPluginKey,
  toggleHeadingFold,
  unfoldAtPos,
} from './heading-fold'

const editors: Editor[] = []

function createEditor(content: JSONContent): Editor {
  const element = document.createElement('div')
  document.body.append(element)
  const editor = new Editor({
    element,
    extensions: [StarterKit, HeadingFoldExtension],
    content,
  })
  editors.push(editor)
  return editor
}

afterEach(() => {
  while (editors.length > 0) {
    const editor = editors.pop()!
    const element = editor.view.dom
    editor.destroy()
    element.parentElement?.remove()
  }
})

function heading(level: number, text: string): JSONContent {
  return { type: 'heading', attrs: { level }, content: [{ type: 'text', text }] }
}

function paragraph(text: string): JSONContent {
  return { type: 'paragraph', content: [{ type: 'text', text }] }
}

function nestedDoc(): JSONContent {
  return {
    type: 'doc',
    content: [
      heading(1, 'Alpha'),
      paragraph('a1'),
      heading(2, 'Beta'),
      paragraph('b1'),
      heading(3, 'Gamma'),
      paragraph('c1'),
      heading(2, 'Delta'),
      paragraph('d1'),
    ],
  }
}

function headingPos(editor: Editor, text: string): number {
  let result = -1
  editor.state.doc.descendants((node, pos) => {
    if (result >= 0) return false
    if (node.type.name === 'heading' && node.textContent === text) {
      result = pos
      return false
    }
    return true
  })
  if (result < 0) throw new Error(`heading not found: ${text}`)
  return result
}

function foldedPositions(editor: Editor): number[] {
  const state = headingFoldPluginKey.getState(editor.state)
  return state ? [...state.folded.keys()] : []
}

describe('heading ranges', () => {
  it('collects top-level headings in document order', () => {
    const editor = createEditor(nestedDoc())

    expect(collectTopLevelHeadings(editor.state.doc).map((record) => record.level)).toEqual([1, 2, 3, 2])
    expect(collectTopLevelHeadings(editor.state.doc).map((record) => record.pos)).toEqual([
      headingPos(editor, 'Alpha'),
      headingPos(editor, 'Beta'),
      headingPos(editor, 'Gamma'),
      headingPos(editor, 'Delta'),
    ])
  })

  it('stops a heading range at the next heading of the same or a higher level', () => {
    const editor = createEditor(nestedDoc())
    const beta = headingPos(editor, 'Beta')
    const delta = headingPos(editor, 'Delta')

    const range = computeHeadingRange(editor.state.doc, beta)

    expect(range).not.toBeNull()
    expect(range!.start).toBe(beta + editor.state.doc.nodeAt(beta)!.nodeSize)
    expect(range!.end).toBe(delta)
  })

  it('runs to the end of the document when no sibling follows', () => {
    const editor = createEditor(nestedDoc())
    const delta = headingPos(editor, 'Delta')

    const range = computeHeadingRange(editor.state.doc, delta)

    expect(range!.end).toBe(editor.state.doc.content.size)
  })

  it('reports an empty range for a heading with no content', () => {
    const editor = createEditor({
      type: 'doc',
      content: [heading(2, 'Empty'), heading(2, 'Next'), paragraph('body')],
    })
    const empty = headingPos(editor, 'Empty')

    const range = computeHeadingRange(editor.state.doc, empty)

    expect(range!.end).toBe(range!.start)
  })

  it('computes nested ranges independently', () => {
    const editor = createEditor(nestedDoc())
    const beta = headingPos(editor, 'Beta')
    const gamma = headingPos(editor, 'Gamma')

    const ranges = computeFoldRanges(editor.state.doc, new Map([
      [beta, 2],
      [gamma, 3],
    ]))

    expect(ranges).toHaveLength(2)
    expect(ranges.find((range) => range.headingPos === gamma)!.end)
      .toBe(headingPos(editor, 'Delta'))
  })
})

describe('toggleHeadingFold', () => {
  it('folds and unfolds a heading', () => {
    const editor = createEditor(nestedDoc())
    const beta = headingPos(editor, 'Beta')

    expect(toggleHeadingFold(editor.view, beta)).toBe(true)
    expect(foldedPositions(editor)).toEqual([beta])

    expect(toggleHeadingFold(editor.view, beta)).toBe(true)
    expect(foldedPositions(editor)).toEqual([])
  })

  it('marks the folded range and the heading node in the rendered DOM', () => {
    const editor = createEditor(nestedDoc())
    const beta = headingPos(editor, 'Beta')

    toggleHeadingFold(editor.view, beta)

    const headingElement = editor.view.nodeDOM(beta) as HTMLElement
    expect(headingElement.classList.contains('is-foldable-heading')).toBe(true)
    expect(headingElement.dataset.headingFolded).toBe('true')

    const gamma = editor.view.nodeDOM(headingPos(editor, 'Gamma')) as HTMLElement
    expect(gamma.classList.contains('is-heading-folded-content')).toBe(true)
  })

  it('does not render a toggle for a heading with no content', () => {
    const editor = createEditor({
      type: 'doc',
      content: [heading(2, 'Empty'), heading(2, 'Next'), paragraph('body')],
    })
    const empty = headingPos(editor, 'Empty')
    const next = headingPos(editor, 'Next')

    expect((editor.view.nodeDOM(empty) as HTMLElement).querySelector('.heading-fold-toggle')).toBeNull()
    expect((editor.view.nodeDOM(next) as HTMLElement).querySelector('.heading-fold-toggle')).not.toBeNull()
  })

  it('refuses to fold a heading with no content', () => {
    const editor = createEditor({
      type: 'doc',
      content: [heading(2, 'Empty'), heading(2, 'Next'), paragraph('body')],
    })
    const empty = headingPos(editor, 'Empty')

    expect(toggleHeadingFold(editor.view, empty)).toBe(false)
    expect(foldedPositions(editor)).toEqual([])
  })

  it('folds and unfolds when the rendered button is clicked', () => {
    const editor = createEditor(nestedDoc())
    const beta = headingPos(editor, 'Beta')
    const buttonAt = () => (editor.view.nodeDOM(beta) as HTMLElement)
      .querySelector<HTMLElement>('.heading-fold-toggle')

    expect(buttonAt()).not.toBeNull()
    buttonAt()!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(foldedPositions(editor)).toEqual([beta])

    expect(buttonAt()).not.toBeNull()
    buttonAt()!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(foldedPositions(editor)).toEqual([])
  })

  it('does not change the document or add history entries', () => {
    const editor = createEditor(nestedDoc())
    const before = editor.getJSON()
    const beta = headingPos(editor, 'Beta')

    toggleHeadingFold(editor.view, beta)

    expect(editor.getJSON()).toEqual(before)
    expect(editor.can().undo()).toBe(false)
  })
})

describe('fold state mapping', () => {
  it('follows a heading when content is inserted before it', () => {
    const editor = createEditor(nestedDoc())
    const beta = headingPos(editor, 'Beta')
    toggleHeadingFold(editor.view, beta)

    editor.commands.insertContentAt(0, paragraph('preface'))

    const state = headingFoldPluginKey.getState(editor.state)!
    expect(state.folded.size).toBe(1)
    const [mapped] = [...state.folded.keys()]
    const node = editor.state.doc.nodeAt(mapped)
    expect(node?.type.name).toBe('heading')
    expect(node?.textContent).toBe('Beta')
  })

  it('follows a heading when a block is inserted exactly at its start', () => {
    const editor = createEditor(nestedDoc())
    const beta = headingPos(editor, 'Beta')
    toggleHeadingFold(editor.view, beta)

    editor.commands.insertContentAt(beta, paragraph('inserted'))

    const state = headingFoldPluginKey.getState(editor.state)!
    expect(state.folded.size).toBe(1)
    const [mapped] = [...state.folded.keys()]
    expect(editor.state.doc.nodeAt(mapped)?.textContent).toBe('Beta')
  })

  it('drops a fold when its heading is deleted', () => {
    const editor = createEditor(nestedDoc())
    const beta = headingPos(editor, 'Beta')
    toggleHeadingFold(editor.view, beta)

    const node = editor.state.doc.nodeAt(beta)!
    editor.commands.deleteRange({ from: beta, to: beta + node.nodeSize })

    expect(foldedPositions(editor)).toEqual([])
  })

  it('clears every fold explicitly', () => {
    const editor = createEditor(nestedDoc())
    const beta = headingPos(editor, 'Beta')
    toggleHeadingFold(editor.view, beta)

    clearHeadingFolds(editor.view)

    expect(foldedPositions(editor)).toEqual([])
  })
})

describe('unfoldAtPos', () => {
  it('unfolds the ancestors that hide the given position', () => {
    const editor = createEditor(nestedDoc())
    const beta = headingPos(editor, 'Beta')
    toggleHeadingFold(editor.view, beta)
    const range = computeHeadingRange(editor.state.doc, beta)!

    expect(unfoldAtPos(editor.view, range.start + 1)).toBe(true)
    expect(foldedPositions(editor)).toEqual([])
  })

  it('does nothing when the position is outside every folded range', () => {
    const editor = createEditor(nestedDoc())
    const beta = headingPos(editor, 'Beta')
    toggleHeadingFold(editor.view, beta)

    expect(unfoldAtPos(editor.view, 1)).toBe(false)
    expect(foldedPositions(editor)).toEqual([beta])
  })

  it('automatically unfolds when the caret enters a folded range', () => {
    const editor = createEditor(nestedDoc())
    const beta = headingPos(editor, 'Beta')
    toggleHeadingFold(editor.view, beta)
    const range = computeHeadingRange(editor.state.doc, beta)!

    editor.commands.setTextSelection(range.start + 1)

    expect(foldedPositions(editor)).toEqual([])
  })

  it('moves the caret out of the range when folding at that position', () => {
    const editor = createEditor(nestedDoc())
    const beta = headingPos(editor, 'Beta')
    const range = computeHeadingRange(editor.state.doc, beta)!
    editor.commands.setTextSelection(range.start + 1)

    toggleHeadingFold(editor.view, beta)

    expect(editor.state.selection.from).toBeLessThanOrEqual(range.start)
  })

  it('does not unfold itself after its own fold transaction', () => {
    const editor = createEditor(nestedDoc())
    const beta = headingPos(editor, 'Beta')
    const range = computeHeadingRange(editor.state.doc, beta)!
    editor.commands.setTextSelection(range.start + 1)

    toggleHeadingFold(editor.view, beta)

    expect(foldedPositions(editor)).toEqual([beta])
  })

  it('leaves the fold alone when the caret sits at the next heading', () => {
    const editor = createEditor(nestedDoc())
    const beta = headingPos(editor, 'Beta')
    const delta = headingPos(editor, 'Delta')
    editor.commands.setTextSelection(delta)

    toggleHeadingFold(editor.view, beta)

    expect(foldedPositions(editor)).toEqual([beta])
    expect(editor.state.selection.from).toBe(delta)
  })
})

describe('findHeadingForPos', () => {
  it('returns the heading containing the caret', () => {
    const editor = createEditor(nestedDoc())
    const gamma = headingPos(editor, 'Gamma')

    expect(findHeadingForPos(editor.state.doc, gamma + 1)).toBe(gamma)
  })

  it('returns the closest preceding heading for body content', () => {
    const editor = createEditor(nestedDoc())
    const gamma = headingPos(editor, 'Gamma')
    const gammaEnd = gamma + editor.state.doc.nodeAt(gamma)!.nodeSize

    expect(findHeadingForPos(editor.state.doc, gammaEnd + 2)).toBe(gamma)
  })

  it('returns null before the first heading', () => {
    const editor = createEditor({
      type: 'doc',
      content: [paragraph('intro'), heading(2, 'Section')],
    })

    expect(findHeadingForPos(editor.state.doc, 1)).toBeNull()
  })
})
