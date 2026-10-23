import { Editor, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it } from 'vitest';

import { insertParagraphAtEdge } from '@features/editor/components/drag-context-menu/actions';
import type { CurrentBlockInfo } from '@features/editor/components/drag-context-menu/block-info';

const editors: Editor[] = [];

function createEditor(content: JSONContent): Editor {
  const editor = new Editor({
    extensions: [StarterKit],
    content,
  });
  editors.push(editor);
  return editor;
}

function targetAt(editor: Editor, pos: number): CurrentBlockInfo {
  const node = editor.state.doc.nodeAt(pos);
  if (!node) throw new Error(`No node at ${pos}`);
  return {
    node,
    typeName: node.type.name,
    attrs: node.attrs,
    pos,
    nodeSize: node.nodeSize,
    dom: document.createElement('div'),
  };
}

function paragraph(text: string): JSONContent {
  return {
    type: 'paragraph',
    content: text ? [{ type: 'text', text }] : [],
  };
}

afterEach(() => {
  editors.splice(0).forEach(editor => editor.destroy());
});

describe('insertParagraphAtEdge', () => {
  it('inserts an empty line above a paragraph', () => {
    const editor = createEditor({
      type: 'doc',
      content: [paragraph('first'), paragraph('second')],
    });
    const secondPos = editor.state.doc.firstChild!.nodeSize;

    expect(insertParagraphAtEdge(editor, targetAt(editor, secondPos), 'before')).toBe(true);

    const doc = editor.state.doc;
    expect(doc.childCount).toBe(3);
    expect(doc.child(0).textContent).toBe('first');
    expect(doc.child(1).textContent).toBe('');
    expect(doc.child(2).textContent).toBe('second');
    expect(editor.state.selection.from).toBe(doc.child(0).nodeSize + 1);
  });

  it('inserts an empty line below a paragraph', () => {
    const editor = createEditor({
      type: 'doc',
      content: [paragraph('first'), paragraph('second')],
    });

    expect(insertParagraphAtEdge(editor, targetAt(editor, 0), 'after')).toBe(true);

    const doc = editor.state.doc;
    expect(doc.childCount).toBe(3);
    expect(doc.child(0).textContent).toBe('first');
    expect(doc.child(1).textContent).toBe('');
    expect(doc.child(2).textContent).toBe('second');
  });

  it('places the line outside a list item', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [{
          type: 'listItem',
          content: [paragraph('item')],
        }],
      }],
    });

    expect(insertParagraphAtEdge(editor, targetAt(editor, 1), 'before')).toBe(true);

    const doc = editor.state.doc;
    expect(doc.child(0).type.name).toBe('paragraph');
    expect(doc.child(0).textContent).toBe('');
    expect(doc.child(1).type.name).toBe('bulletList');
  });

  it('undoes in one step', () => {
    const editor = createEditor({
      type: 'doc',
      content: [paragraph('first')],
    });

    insertParagraphAtEdge(editor, targetAt(editor, 0), 'after');
    expect(editor.state.doc.childCount).toBe(2);

    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.childCount).toBe(1);
  });
});
