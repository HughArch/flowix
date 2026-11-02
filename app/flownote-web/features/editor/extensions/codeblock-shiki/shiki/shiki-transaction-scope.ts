import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { Transaction } from '@tiptap/pm/state'

import { getShikiLanguageDefinition } from './shiki-languages'

function nodeNeedsShikiLoad(node: ProseMirrorNode | null | undefined): boolean {
  const language = typeof node?.attrs.language === 'string' ? node.attrs.language : null
  // A newly created plain code block still needs the lazy Shiki bootstrap.
  return (
    language === null || language === '' || language === 'plaintext'
    || getShikiLanguageDefinition(language) !== null
  )
}

function nodeAtPosition(doc: ProseMirrorNode, position: number): ProseMirrorNode | null {
  return doc.nodeAt(position) ?? doc.resolve(position).nodeAfter
}

function rangeContainsCodeBlock(
  doc: ProseMirrorNode,
  from: number,
  to: number,
  typeName: string
): boolean {
  let found = false
  doc.nodesBetween(from, to, (node) => {
    if (node.type.name === typeName) {
      found = true
      return false
    }
  })
  return found
}

function rangeTouchesCodeBlock(
  doc: ProseMirrorNode,
  from: number,
  to: number,
  typeName: string,
): boolean {
  if (from < to && rangeContainsCodeBlock(doc, from, to, typeName)) return true

  // Insertion/deletion maps can have a zero-width side. In that case inspect
  // the parent at the boundary so editing text inside a code block is not
  // mistaken for creating/removing the block itself.
  const position = Math.max(0, Math.min(from, doc.content.size))
  return doc.resolve(position).parent.type.name === typeName
}

function isCodeBlockAttributeChange(
  step: unknown,
  oldDoc: ProseMirrorNode,
  newDoc: ProseMirrorNode,
  typeName: string,
): boolean {
  const candidate = step as {
    pos?: unknown
    attr?: unknown
    from?: unknown
  }

  // AttrStep has an explicit `pos` + `attr` pair. A plain ReplaceStep also
  // has `from`, so `from` alone must never classify it as an attribute edit.
  if (typeof candidate.pos === 'number' && typeof candidate.attr === 'string') {
    return nodeAtPosition(oldDoc, candidate.pos)?.type.name === typeName
      || nodeAtPosition(newDoc, candidate.pos)?.type.name === typeName
  }

  // setNodeMarkup is represented by ReplaceAroundStep in ProseMirror. It has
  // no dedicated attribute marker, so only treat it as an attribute change
  // when the same code block exists at `from` and its attrs actually differ.
  if (typeof candidate.from !== 'number') return false
  const oldNode = nodeAtPosition(oldDoc, candidate.from)
  const newNode = nodeAtPosition(newDoc, candidate.from)
  if (oldNode?.type.name !== typeName || newNode?.type.name !== typeName) return false

  const oldAttrs = oldNode.attrs
  const newAttrs = newNode.attrs
  const keys = new Set([...Object.keys(oldAttrs), ...Object.keys(newAttrs)])
  return [...keys].some((key) => oldAttrs[key] !== newAttrs[key])
}

export function transactionTouchesCodeBlock(
  transaction: Transaction,
  typeName: string,
): boolean {
  return transaction.steps.some((step, index) => {
    const oldDoc = transaction.docs[index]
    const newDoc = transaction.docs[index + 1] ?? transaction.doc
    let touchesCodeBlock = false

    if (isCodeBlockAttributeChange(step, oldDoc, newDoc, typeName)) {
      const candidate = step as { pos?: unknown; from?: unknown }
      const position = typeof candidate.pos === 'number'
        ? candidate.pos
        : typeof candidate.from === 'number'
          ? candidate.from
          : null
      return position !== null
        ? nodeAtPosition(oldDoc, position)?.type.name === typeName
          || nodeAtPosition(newDoc, position)?.type.name === typeName
        : false
    }

    step.getMap().forEach((oldStart, oldEnd, newStart, newEnd) => {
      if (touchesCodeBlock) return
      touchesCodeBlock = (
        rangeTouchesCodeBlock(oldDoc, oldStart, oldEnd, typeName)
        || rangeTouchesCodeBlock(newDoc, newStart, newEnd, typeName)
      )
    })
    return touchesCodeBlock
  })
}

export function transactionNeedsShikiLoad(
  transaction: Transaction,
  typeName: string,
): boolean {
  return transaction.steps.some((step, index) => {
    const oldDoc = transaction.docs[index]
    const newDoc = transaction.docs[index + 1] ?? transaction.doc

    if (isCodeBlockAttributeChange(step, oldDoc, newDoc, typeName)) {
      const candidate = step as { pos?: unknown; from?: unknown }
      const position = typeof candidate.pos === 'number'
        ? candidate.pos
        : typeof candidate.from === 'number'
          ? candidate.from
          : null
      return position !== null && nodeNeedsShikiLoad(nodeAtPosition(newDoc, position))
    }

    let oldTouchesCodeBlock = false
    let newTouchesCodeBlock = false
    step.getMap().forEach((oldStart, oldEnd, newStart, newEnd) => {
      oldTouchesCodeBlock ||= rangeTouchesCodeBlock(oldDoc, oldStart, oldEnd, typeName)
      newTouchesCodeBlock ||= rangeTouchesCodeBlock(newDoc, newStart, newEnd, typeName)
    })
    // Removing a code block does not introduce a grammar. Only a newly
    // inserted code block needs the lazy language-loading path.
    if (oldTouchesCodeBlock || !newTouchesCodeBlock) return false

    let needsLoad = false
    step.getMap().forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      if (needsLoad) return
      newDoc.nodesBetween(newStart, Math.min(newEnd, newDoc.content.size), (node) => {
        if (node.type.name === typeName && nodeNeedsShikiLoad(node)) {
          needsLoad = true
          return false
        }
      })
      const boundaryNode = nodeAtPosition(newDoc, newStart)
      if (boundaryNode?.type.name === typeName && nodeNeedsShikiLoad(boundaryNode)) {
        needsLoad = true
      }
    })
    return needsLoad
  })
}
