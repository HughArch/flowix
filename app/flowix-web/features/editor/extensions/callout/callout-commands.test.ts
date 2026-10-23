import { Editor, type JSONContent } from '@tiptap/core';
import type { Node as PMNode } from 'prosemirror-model';
import { afterEach, describe, expect, it } from 'vitest';
import { createMarkdownEditorExtensions } from '../../markdown-editor-extensions';
import { isAtCalloutStart, isCalloutShortcut } from './callout-commands';

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

describe('callout commands', () => {
  it('wraps the paragraph at the cursor and keeps the caret offset', () => {
    const editor = createEditor({ type: 'doc', content: [paragraph('hello')] });
    editor.commands.setTextSelection(3);

    expect(editor.commands.setCallout()).toBe(true);

    const first = editor.state.doc.firstChild!;
    expect(first.type.name).toBe('callout');
    expect(first.attrs).toMatchObject({ icon: '💡', color: 'orange' });
    expect(first.textContent).toBe('hello');
    expect(editor.state.selection.empty).toBe(true);
    expect(editor.state.selection.$from.parent.textContent).toBe('hello');
    expect(editor.state.selection.$from.parentOffset).toBe(2);
  });

  it('unwraps a callout back into its children', () => {
    const editor = createEditor({ type: 'doc', content: [paragraph('hello')] });
    editor.commands.setTextSelection(3);
    editor.commands.setCallout();

    expect(editor.commands.unsetCallout()).toBe(true);

    const first = editor.state.doc.firstChild!;
    expect(first.type.name).toBe('paragraph');
    expect(first.textContent).toBe('hello');
    expect(editor.state.selection.$from.parentOffset).toBe(2);
  });

  it('wraps a paragraph inside a column without touching the columns container', () => {
    const editor = createEditor(columnsDocument('左', '右'));
    const paragraphNode = findNode(editor, 'paragraph')!;
    editor.commands.setTextSelection(paragraphNode.pos + 2);

    expect(editor.commands.setCallout()).toBe(true);

    const columns = editor.state.doc.firstChild!;
    expect(columns.type.name).toBe('columns');
    expect(columns.childCount).toBe(2);
    const column = columns.firstChild!;
    expect(column.type.name).toBe('column');
    expect(column.firstChild!.type.name).toBe('callout');
    expect(column.firstChild!.textContent).toBe('左');
    expect(columns.lastChild!.textContent).toBe('右');
  });

  it('recognises the callout start for Backspace unwrapping', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{
        type: 'callout',
        attrs: { icon: '💡', color: 'gray' },
        content: [paragraph('hello'), paragraph('world')],
      }],
    });
    const callout = editor.state.doc.firstChild!;
    const firstParagraphStart = callout.firstChild!.textContent.length;

    editor.commands.setTextSelection(2);
    expect(isAtCalloutStart(editor.state)).toBe(true);

    editor.commands.setTextSelection(3);
    expect(isAtCalloutStart(editor.state)).toBe(false);

    // Start of the second block is not the callout start.
    editor.commands.setTextSelection(2 + firstParagraphStart + 2);
    expect(isAtCalloutStart(editor.state)).toBe(false);
  });

  it('does not unwrap the callout from inside a list item', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{
        type: 'callout',
        content: [{
          type: 'bulletList',
          content: [{
            type: 'listItem',
            content: [paragraph('item')],
          }],
        }],
      }],
    });
    const listItem = findNode(editor, 'paragraph')!;

    // Backspace on the first list item must stay with the list (marker /
    // outdent), never delete the surrounding container.
    editor.commands.setTextSelection(listItem.pos + 1);
    expect(isAtCalloutStart(editor.state)).toBe(false);
  });

  it('does not unwrap the callout from inside an ordered list', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{
        type: 'callout',
        content: [{
          type: 'orderedList',
          content: [{
            type: 'listItem',
            content: [paragraph('first')],
          }],
        }],
      }],
    });
    const listItem = findNode(editor, 'paragraph')!;

    editor.commands.setTextSelection(listItem.pos + 1);
    expect(isAtCalloutStart(editor.state)).toBe(false);

    // The callout is still intact.
    expect(editor.state.doc.firstChild!.type.name).toBe('callout');
    expect(editor.state.doc.firstChild!.firstChild!.type.name).toBe('orderedList');
  });

  it('does not unwrap the callout from inside a quote or column', () => {
    const quoted = createEditor({
      type: 'doc',
      content: [{
        type: 'callout',
        content: [{
          type: 'blockquote',
          content: [paragraph('quoted')],
        }],
      }],
    });
    const quotedParagraph = findNode(quoted, 'paragraph')!;
    quoted.commands.setTextSelection(quotedParagraph.pos + 1);
    expect(isAtCalloutStart(quoted.state)).toBe(false);

    const columned = createEditor({
      type: 'doc',
      content: [{
        type: 'callout',
        content: [{
          type: 'columns',
          content: [{
            type: 'column',
            content: [paragraph('left')],
          }, {
            type: 'column',
            content: [paragraph('right')],
          }],
        }],
      }],
    });
    const columnParagraph = findNode(columned, 'paragraph')!;
    columned.commands.setTextSelection(columnParagraph.pos + 1);
    expect(isAtCalloutStart(columned.state)).toBe(false);
  });

  it('keeps the document valid when the only child block is deleted', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{ type: 'callout', content: [paragraph('only')] }],
    });
    const paragraphNode = findNode(editor, 'paragraph')!;

    editor.commands.deleteRange({
      from: paragraphNode.pos,
      to: paragraphNode.pos + paragraphNode.node.nodeSize,
    });

    expect(() => editor.state.doc.check()).not.toThrow();
    const callout = editor.state.doc.firstChild!;
    expect(callout.type.name).toBe('callout');
    expect(callout.childCount).toBe(1);
    expect(callout.firstChild!.type.name).toBe('paragraph');
  });

  it('wraps the containing list when the caret is in a list item leading paragraph', () => {
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
    const paragraphNode = findNode(editor, 'paragraph')!;
    editor.commands.setTextSelection(paragraphNode.pos + 1);

    expect(editor.commands.setCallout()).toBe(true);

    const first = editor.state.doc.firstChild!;
    expect(first.type.name).toBe('callout');
    expect(first.firstChild!.type.name).toBe('bulletList');
    expect(first.textContent).toBe('item');
  });

  it('keeps the !! shortcut inert in a list item leading paragraph', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [{
          type: 'listItem',
          content: [paragraph('!!')],
        }],
      }],
    });
    editor.commands.setTextSelection(5);

    const handled = editor.view.someProp('handleTextInput', (handler) => (
      handler(editor.view, 5, 5, ' ', () => editor.state.tr)
    ));

    expect(handled).toBeFalsy();
    expect(editor.state.doc.firstChild!.type.name).toBe('bulletList');
  });

  it('undoes a wrap in one step', () => {
    const editor = createEditor({ type: 'doc', content: [paragraph('hello')] });
    editor.commands.setTextSelection(3);
    editor.commands.setCallout();
    expect(editor.state.doc.firstChild!.type.name).toBe('callout');

    editor.commands.undo();
    expect(editor.state.doc.firstChild!.type.name).toBe('paragraph');
    expect(editor.state.doc.firstChild!.textContent).toBe('hello');
  });

  it('matches the !! shortcut only on an otherwise empty paragraph', () => {
    const editor = createEditor({ type: 'doc', content: [paragraph('!!')] });
    const paragraphNode = editor.state.doc.firstChild!;

    expect(isCalloutShortcut(paragraphNode, 2)).toBe(true);
    expect(isCalloutShortcut(paragraphNode, 1)).toBe(false);

    const notEmpty = createEditor({ type: 'doc', content: [paragraph('a!!')] }).state.doc.firstChild!;
    expect(isCalloutShortcut(notEmpty, 3)).toBe(false);
  });

  it('turns !! + space into a callout through the text-input plugin', () => {
    const editor = createEditor({ type: 'doc', content: [paragraph('!!')] });
    editor.commands.setTextSelection(3);

    const handled = editor.view.someProp('handleTextInput', (handler) => (
      handler(editor.view, 3, 3, ' ', () => editor.state.tr)
    ));

    expect(handled).toBe(true);
    const callout = editor.state.doc.firstChild!;
    expect(callout.type.name).toBe('callout');
    expect(callout.attrs).toMatchObject({ icon: '💡', color: 'orange' });
    expect(callout.childCount).toBe(1);
    expect(callout.firstChild!.type.name).toBe('paragraph');
    expect(callout.firstChild!.content.size).toBe(0);
    expect(editor.state.selection.$from.pos).toBe(2);
  });

  it('leaves ordinary spaces alone', () => {
    const editor = createEditor({ type: 'doc', content: [paragraph('hi')] });
    editor.commands.setTextSelection(3);

    const handled = editor.view.someProp('handleTextInput', (handler) => (
      handler(editor.view, 3, 3, ' ', () => editor.state.tr)
    ));

    expect(handled).toBeFalsy();
  });
});
