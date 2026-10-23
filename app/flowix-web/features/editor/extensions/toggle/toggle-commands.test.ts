import { Editor, type JSONContent } from '@tiptap/core';
import type { Node as PMNode } from 'prosemirror-model';
import { afterEach, describe, expect, it } from 'vitest';
import { createMarkdownEditorExtensions } from '../../markdown-editor-extensions';
import { isAtToggleStart } from './toggle-commands';
import { TOGGLE_NODE_NAME } from './toggle-markdown';

const editors: Editor[] = [];

function createEditor(content: string | JSONContent): Editor {
  const editor = new Editor({
    extensions: createMarkdownEditorExtensions({
      getOwnerPath: () => undefined,
      getAttachmentNotebookId: () => undefined,
      workspaceHost: 'main-third',
      getPlaceholder: () => '',
      getHeadingFoldLabels: () => ({ fold: '', unfold: '' }),
    }),
    content,
    contentType: typeof content === 'string' ? 'markdown' : 'json',
  });
  editors.push(editor);
  return editor;
}

afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()));

function findNode(editor: Editor, type: string): { pos: number; node: PMNode } | null {
  let found: { pos: number; node: PMNode } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === type) {
      found = { pos, node };
      return false;
    }
    return true;
  });
  return found;
}

function paragraph(text: string): JSONContent {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

function columnsDocument(left: string, right: string): JSONContent {
  return {
    type: 'doc',
    content: [{
      type: 'columns',
      content: [
        { type: 'column', attrs: { width: 100 }, content: [paragraph(left)] },
        { type: 'column', attrs: { width: 100 }, content: [paragraph(right)] },
      ],
    }],
  };
}

describe('toggle commands', () => {
  it('wraps the paragraph at the cursor and keeps the caret offset', () => {
    const editor = createEditor({ type: 'doc', content: [paragraph('hello')] });
    editor.commands.setTextSelection(3);

    expect(editor.commands.setToggle()).toBe(true);

    const first = editor.state.doc.firstChild!;
    expect(first.type.name).toBe(TOGGLE_NODE_NAME);
    expect(first.attrs).toMatchObject({ open: true });
    expect(first.childCount).toBe(1);
    expect(first.textContent).toBe('hello');
    expect(editor.state.selection.empty).toBe(true);
    expect(editor.state.selection.$from.parent.textContent).toBe('hello');
    expect(editor.state.selection.$from.parentOffset).toBe(2);
  });

  it('unwraps a toggle back into its children', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{
        type: TOGGLE_NODE_NAME,
        attrs: { open: true },
        content: [paragraph('title'), paragraph('body')],
      }],
    });
    editor.commands.setTextSelection(3);

    expect(editor.commands.unsetToggle()).toBe(true);

    // The editor's trailing-node plugin keeps an empty paragraph after the
    // unwrapped blocks; only the toggle's own children are relevant here.
    const types = Array.from({ length: editor.state.doc.childCount }, (_, index) => (
      editor.state.doc.child(index).type.name
    ));
    expect(types.slice(0, 2)).toEqual(['paragraph', 'paragraph']);
    expect(editor.state.doc.firstChild!.textContent).toBe('title');
  });

  it('wraps a paragraph inside a column without touching the columns container', () => {
    const editor = createEditor(columnsDocument('左', '右'));
    const paragraphNode = findNode(editor, 'paragraph')!;
    editor.commands.setTextSelection(paragraphNode.pos + 2);

    expect(editor.commands.setToggle()).toBe(true);

    const columns = editor.state.doc.firstChild!;
    expect(columns.type.name).toBe('columns');
    expect(columns.childCount).toBe(2);
    const column = columns.firstChild!;
    expect(column.type.name).toBe('column');
    expect(column.firstChild!.type.name).toBe(TOGGLE_NODE_NAME);
    expect(column.firstChild!.textContent).toBe('左');
    expect(columns.lastChild!.textContent).toBe('右');
  });

  it('wraps the whole list behind an empty title when the caret is in a required leading paragraph', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [{ type: 'listItem', content: [paragraph('item')] }],
      }],
    });
    editor.commands.setTextSelection(3);

    expect(editor.commands.setToggle()).toBe(true);

    const first = editor.state.doc.firstChild!;
    expect(first.type.name).toBe(TOGGLE_NODE_NAME);
    expect(first.childCount).toBe(2);
    // A list cannot be a title line; it becomes the body behind an empty title.
    expect(first.firstChild!.type.name).toBe('paragraph');
    expect(first.firstChild!.content.size).toBe(0);
    expect(first.lastChild!.type.name).toBe('bulletList');
    expect(first.textContent).toBe('item');
    // The caret stays inside the list item.
    expect(editor.state.selection.$from.parent.textContent).toBe('item');
  });

  it('does not wrap an existing toggle', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{
        type: TOGGLE_NODE_NAME,
        attrs: { open: true },
        content: [paragraph('title')],
      }],
    });
    editor.commands.setTextSelection(3);

    expect(editor.commands.setToggle()).toBe(false);
  });

  it('undoes the wrap as one step', () => {
    const editor = createEditor({ type: 'doc', content: [paragraph('hello')] });
    editor.commands.setTextSelection(3);
    editor.commands.setToggle();

    editor.commands.undo();

    expect(editor.state.doc.firstChild!.type.name).toBe('paragraph');
    expect(editor.state.doc.firstChild!.textContent).toBe('hello');
  });

  it('recognises only the title start for Backspace unwrapping', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{
        type: TOGGLE_NODE_NAME,
        attrs: { open: true },
        content: [paragraph('title'), paragraph('body')],
      }],
    });

    editor.commands.setTextSelection(2);
    expect(isAtToggleStart(editor.state)).toBe(true);

    editor.commands.setTextSelection(3);
    expect(isAtToggleStart(editor.state)).toBe(false);

    // The body's first line is not a title, so Backspace keeps the container.
    const bodyStart = 1 + editor.state.doc.firstChild!.firstChild!.nodeSize;
    editor.commands.setTextSelection(bodyStart + 1);
    expect(isAtToggleStart(editor.state)).toBe(false);
  });

  it('does not unwrap when the caret is inside a nested structure of the title', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{
        type: TOGGLE_NODE_NAME,
        attrs: { open: true },
        content: [{
          type: 'bulletList',
          content: [{ type: 'listItem', content: [paragraph('item')] }],
        }],
      }],
    });
    editor.commands.setTextSelection(5);

    expect(isAtToggleStart(editor.state)).toBe(false);
  });
});
