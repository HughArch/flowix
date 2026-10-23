import { Editor, type JSONContent } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createMarkdownEditorExtensions } from '@features/editor/markdown-editor-extensions';
import { getBlockInfoAtCoords, getCurrentBlockInfo } from './block-info';

const editors: Editor[] = [];
const originalElementFromPoint = document.elementFromPoint;

function createEditor(content: JSONContent): Editor {
  const element = document.createElement('div');
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: createMarkdownEditorExtensions({
      getOwnerPath: () => undefined,
      getAttachmentNotebookId: () => undefined,
      workspaceHost: 'main-third',
      getPlaceholder: () => '',
      getHeadingFoldLabels: () => ({ fold: '', unfold: '' }),
    }),
    content,
    contentType: 'json',
  });
  editors.push(editor);
  return editor;
}

function pointAt(element: Element | null): void {
  document.elementFromPoint = () => element as Element | null;
}

function toggleDocument(open = true): JSONContent {
  return {
    type: 'doc',
    content: [{
      type: 'toggle',
      attrs: { open },
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'title' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'body' }] },
      ],
    }],
  };
}

afterEach(() => {
  document.elementFromPoint = originalElementFromPoint;
  editors.splice(0).forEach((editor) => editor.destroy());
  document.body.innerHTML = '';
});

describe('toggle drag targets', () => {
  it('resolves the container when hovering the chevron', () => {
    const editor = createEditor(toggleDocument());
    pointAt(editor.view.dom.querySelector('.flowix-toggle-chevron'));

    const info = getBlockInfoAtCoords(editor, 0, 0);

    expect(info?.typeName).toBe('toggle');
    expect(info?.pos).toBe(0);
  });

  it('resolves the container when hovering the title row', () => {
    const editor = createEditor(toggleDocument());
    pointAt(editor.view.dom.querySelector('.flowix-toggle-content > p'));

    const info = getBlockInfoAtCoords(editor, 0, 0);

    expect(info?.typeName).toBe('toggle');
    expect(info?.pos).toBe(0);
  });

  it('resolves the hovered body row as an inner block', () => {
    const editor = createEditor(toggleDocument());
    pointAt(editor.view.dom.querySelectorAll('.flowix-toggle-content > p')[1]);

    const info = getBlockInfoAtCoords(editor, 0, 0);

    expect(info?.typeName).toBe('paragraph');
    expect(info?.node.textContent).toBe('body');
  });

  it('keeps a callout inside the body as its own drag target', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{
        type: 'toggle',
        attrs: { open: true },
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'title' }] },
          {
            type: 'callout',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'inside' }] }],
          },
        ],
      }],
    });
    pointAt(editor.view.dom.querySelector('.flowix-callout-icon'));

    const info = getBlockInfoAtCoords(editor, 0, 0);

    expect(info?.typeName).toBe('callout');
  });
});

describe('toggle selection targets', () => {
  it('resolves the container when the caret is in the title', () => {
    const editor = createEditor(toggleDocument());
    editor.commands.setTextSelection(3);

    const info = getCurrentBlockInfo(editor);

    expect(info?.typeName).toBe('toggle');
    expect(info?.pos).toBe(0);
  });

  it('resolves the inner block when the caret is in the body', () => {
    const editor = createEditor(toggleDocument());
    // Toggle open token at 0; title paragraph at 1 (nodeSize 7); body text at 9.
    editor.commands.setTextSelection(9);

    const info = getCurrentBlockInfo(editor);

    expect(info?.typeName).toBe('paragraph');
    expect(info?.node.textContent).toBe('body');
  });
});
