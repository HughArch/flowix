import { Schema } from '@tiptap/pm/model'
import { describe, expect, it } from 'vitest'

import { createShikiDecorationSet, getDecorations } from './shiki-decorations'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    text: { group: 'inline' },
    codeBlock: {
      attrs: {
        language: { default: 'javascript' },
        theme: { default: 'github-light' },
      },
      content: 'text*',
      group: 'block',
    },
  },
})

describe('Shiki code block decorations', () => {
  it('does not insert atomic widgets at line boundaries', () => {
    const codeBlock = schema.node(
      'codeBlock',
      { language: 'javascript', theme: 'github-light' },
      schema.text('alpha\nbeta\ngamma'),
    )
    const doc = schema.node('doc', null, [codeBlock])

    const inputs = [{
      from: 1,
      text: 'alpha\nbeta\ngamma',
      language: 'javascript',
      theme: 'github-light',
    }]
    const decorations = createShikiDecorationSet(
      doc,
      {
        doc,
        name: 'codeBlock',
        defaultLanguage: 'plaintext',
        defaultTheme: 'github-light',
      },
      inputs,
      [{
        from: 1,
        lines: [
          [{ content: 'alpha', color: '#ffffff' }],
          [{ content: 'beta', color: '#ffffff' }],
          [{ content: 'gamma', color: '#ffffff' }],
        ],
      }],
    ).find()

    expect(decorations).toHaveLength(3)
    expect(decorations.every(({ from, to }) => from < to)).toBe(true)
  })

  it('applies Shiki decorations to Mermaid code mode', () => {
    const codeBlock = schema.node(
      'codeBlock',
      { language: 'mermaid', theme: 'github-light' },
      schema.text('graph TD\nA-->B'),
    )
    const doc = schema.node('doc', null, [codeBlock])

    const decorations = getDecorations({
      doc,
      name: 'codeBlock',
      defaultLanguage: 'plaintext',
      defaultTheme: 'github-light',
    }).find()

    expect(decorations.length).toBeGreaterThan(0)
    expect(decorations.every(({ from, to }) => from < to)).toBe(true)
  })
})
