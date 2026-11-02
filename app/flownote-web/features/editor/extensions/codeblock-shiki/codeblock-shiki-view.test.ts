import { describe, expect, it, vi } from 'vitest'
import { Editor, Node } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'

import { CodeBlockShiki } from './codeblock-shiki'
import { createCodeBlockShikiView } from './codeblock-shiki-view'

const TestAtomBlock = Node.create({
  name: 'testAtomBlock',
  group: 'block',
  atom: true,
  selectable: true,
  renderHTML() {
    return ['div', { 'data-test-atom-block': 'true' }]
  },
})

function createPlainTextView(language = 'plaintext', collapsed = false) {
  return createCodeBlockShikiView({
    node: {
      attrs: {
        language,
        theme: 'github-light',
        collapsed,
      },
      textContent: 'alpha\nbeta\ngamma',
    },
    view: {},
    getPos: () => 0,
    decorations: [],
    innerDecorations: {},
    editor: {},
    extension: {},
    HTMLAttributes: {},
  } as never)
}

describe('CodeBlockShikiView DOM contract', () => {
  it('isolates contentDOM in a canonical pre > code subtree', () => {
    const nodeView = createPlainTextView()

    expect(nodeView.dom.tagName).toBe('DIV')

    const pre = nodeView.dom.querySelector(':scope > pre.code-block-editor')
    expect(pre).toBeInstanceOf(HTMLPreElement)
    expect(pre?.childNodes).toHaveLength(1)
    expect(pre?.firstChild).toBe(nodeView.contentDOM)
    expect(nodeView.contentDOM.tagName).toBe('CODE')
    expect(nodeView.contentDOM.classList.contains('code-block-content')).toBe(true)

    nodeView.destroy()
  })

  it('keeps non-document chrome outside the editable pre', () => {
    const nodeView = createPlainTextView()
    const pre = nodeView.dom.querySelector(':scope > pre.code-block-editor')

    expect(pre?.querySelector('.code-block-header')).toBeNull()
    expect(pre?.querySelector('.code-block-language-dropdown')).toBeNull()
    expect(pre?.querySelector('.code-block-mermaid-preview')).toBeNull()

    expect(nodeView.dom.querySelector(':scope > .code-block-header')).not.toBeNull()
    expect(nodeView.dom.querySelector(':scope > .code-block-language-dropdown')).toBeNull()
    expect(document.body.querySelector('.code-block-language-dropdown')).toBeNull()
    expect(nodeView.dom.querySelector(':scope > .code-block-mermaid-preview')).toBeNull()

    nodeView.destroy()
  })

  it('keeps the editable pre first in DOM order for IME composition stability', () => {
    const nodeView = createPlainTextView()

    expect(nodeView.dom.firstElementChild).toBe(nodeView.dom.querySelector(':scope > pre.code-block-editor'))

    nodeView.destroy()
  })

  it('exposes the collapse toggle in the header', () => {
    const nodeView = createPlainTextView()
    const button = nodeView.dom.querySelector<HTMLButtonElement>('.code-block-collapse-btn')

    expect(button).not.toBeNull()
    expect(button?.tabIndex).toBe(-1)
    expect(button?.closest('.code-block-header')).not.toBeNull()
    expect(button?.querySelector('svg')).not.toBeNull()
    expect(nodeView.dom.dataset.collapsed).toBe('false')
    expect(button?.getAttribute('aria-expanded')).toBe('true')

    nodeView.destroy()

    const collapsedView = createPlainTextView('plaintext', true)
    expect(collapsedView.dom.dataset.collapsed).toBe('true')
    expect(
      collapsedView.dom.querySelector('.code-block-collapse-btn')?.getAttribute('aria-expanded'),
    ).toBe('false')

    collapsedView.destroy()
  })

  it('renders the language dropdown through the document body', () => {
    const nodeView = createPlainTextView()
    const languageButton = nodeView.dom.querySelector<HTMLButtonElement>('.code-block-language-selector')

    expect(document.body.querySelector('.code-block-language-dropdown')).toBeNull()

    languageButton?.click()
    const dropdown = document.body.querySelector<HTMLElement>('.code-block-language-dropdown')
    expect(dropdown).not.toBeNull()
    expect(dropdown?.parentElement).toBe(document.body)
    expect(dropdown?.style.display).toBe('block')

    languageButton?.click()
    expect(dropdown?.style.display).toBe('none')

    nodeView.destroy()
    expect(document.body.contains(dropdown)).toBe(false)
  })

  it('creates Mermaid-only controls only for Mermaid blocks', () => {
    const plainNodeView = createPlainTextView()
    expect(plainNodeView.dom.querySelector('.code-block-mode-tabs')).toBeNull()
    expect(plainNodeView.dom.querySelector('.code-block-mermaid-preview')).toBeNull()
    plainNodeView.destroy()

    const mermaidNodeView = createPlainTextView('mermaid')
    expect(mermaidNodeView.dom.querySelector('.code-block-mode-tabs')).not.toBeNull()
    expect(mermaidNodeView.dom.querySelector('.code-block-mermaid-preview')).not.toBeNull()
    mermaidNodeView.destroy()
  })

  it('initializes clipboard handling on first use without losing the first copy', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const nodeView = createPlainTextView()
    const copyButton = nodeView.dom.querySelector<HTMLButtonElement>('.code-block-copy-btn')

    expect(copyButton?.querySelector('svg')).not.toBeNull()
    copyButton?.click()
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('alpha\nbeta\ngamma'))

    nodeView.destroy()
  })

  it.each([
    ['a text selection', 6, 9, 'alpha\na\ngamma'],
    ['Backspace at the start of the next line', 5, 6, 'alphabeta\ngamma'],
    ['Delete at the end of the previous line', 5, 6, 'alphabeta\ngamma'],
  ])(
    'preserves trailing content after %s',
    (_scenario, deleteFrom, deleteTo, expectedCode) => {
    Object.defineProperties(Range.prototype, {
      getClientRects: {
        configurable: true,
        value: () => [],
      },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({
          bottom: 0,
          height: 0,
          left: 0,
          right: 0,
          top: 0,
          width: 0,
        }),
      },
    })

    const mount = document.createElement('div')
    document.body.appendChild(mount)

    const editor = new Editor({
      element: mount,
      extensions: [
        StarterKit.configure({ codeBlock: false }),
        CodeBlockShiki,
      ],
      content: {
        type: 'doc',
        content: [
          {
            type: 'codeBlock',
            content: [{ type: 'text', text: 'alpha\nbeta\ngamma' }],
          },
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'after' }],
          },
        ],
      },
    })

    try {
      const code = mount.querySelector('pre.code-block-editor > code')
      const text = code?.firstChild
      expect(text).toBeInstanceOf(Text)

      const range = document.createRange()
      range.setStart(text!, deleteFrom)
      range.setEnd(text!, deleteTo)

      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      range.deleteContents()

      ;(editor.view as typeof editor.view & {
        domObserver: { flush: () => void }
      }).domObserver.flush()

      expect(editor.state.doc.child(0).textContent).toBe(expectedCode)
      expect(editor.state.doc.child(1).textContent).toBe('after')
    } finally {
      editor.destroy()
      mount.remove()
    }
    },
  )

  it('does not delete the previous atom block when Backspace is pressed at the start of non-empty code', () => {
    const mount = document.createElement('div')
    document.body.appendChild(mount)

    const editor = new Editor({
      element: mount,
      extensions: [
        StarterKit.configure({ codeBlock: false }),
        TestAtomBlock,
        CodeBlockShiki,
      ],
      content: {
        type: 'doc',
        content: [
          {
            type: 'testAtomBlock',
          },
          {
            type: 'codeBlock',
            content: [{ type: 'text', text: 'const value = 1' }],
          },
        ],
      },
    })

    try {
      let codeBlockPos = -1
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'codeBlock') {
          codeBlockPos = pos
          return false
        }
      })
      expect(codeBlockPos).toBeGreaterThanOrEqual(0)

      editor.commands.setTextSelection(codeBlockPos + 1)
      const beforeBackspace = editor.getJSON()
      editor.commands.keyboardShortcut('Backspace')

      expect(editor.getJSON()).toEqual(beforeBackspace)
    } finally {
      editor.destroy()
      mount.remove()
    }
  })
})
