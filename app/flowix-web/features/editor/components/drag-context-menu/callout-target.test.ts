import { Editor, type JSONContent } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createMarkdownEditorExtensions } from '@features/editor/markdown-editor-extensions';
import { getBlockInfoAtCoords } from './block-info';

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

afterEach(() => {
  document.elementFromPoint = originalElementFromPoint;
  editors.splice(0).forEach((editor) => editor.destroy());
  document.body.innerHTML = '';
});

describe('callout drag targets', () => {
  it('resolves the container when hovering the icon rail', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{
        type: 'callout',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'inside' }] }],
      }],
    });
    pointAt(editor.view.dom.querySelector('.flowix-callout-icon'));

    const info = getBlockInfoAtCoords(editor, 0, 0);

    expect(info?.typeName).toBe('callout');
    expect(info?.pos).toBe(0);
  });

  it('resolves the container when hovering the vertical padding', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{
        type: 'callout',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'inside' }] }],
      }],
    });
    pointAt(editor.view.dom.querySelector('.flowix-callout'));

    // Above the content band: the container owns the handle.
    const info = getBlockInfoAtCoords(editor, 0, -5);

    expect(info?.typeName).toBe('callout');
  });

  it('resolves the row when approaching from the left through the padding', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{
        type: 'callout',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'first' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'second' }] },
        ],
      }],
    });
    // The pointer is over the callout's left padding (not the content DOM) but
    // vertically on the first row.
    pointAt(editor.view.dom.querySelector('.flowix-callout'));

    const info = getBlockInfoAtCoords(editor, 0, 0);

    expect(info?.typeName).toBe('paragraph');
    expect(info?.node.textContent).toBe('first');
  });

  it('resolves the hovered inner paragraph', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{
        type: 'callout',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'inside' }] }],
      }],
    });
    pointAt(editor.view.dom.querySelector('.flowix-callout-content > p'));

    const info = getBlockInfoAtCoords(editor, 0, 0);

    expect(info?.typeName).toBe('paragraph');
    expect(info?.node.textContent).toBe('inside');
  });

  it('resolves an inner list item as the list item, not its paragraph', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{
        type: 'callout',
        content: [{
          type: 'bulletList',
          content: [{
            type: 'listItem',
            content: [{
              type: 'paragraph',
              content: [{ type: 'text', text: 'item' }],
            }],
          }],
        }],
      }],
    });
    pointAt(editor.view.dom.querySelector('.flowix-callout-content li'));

    const info = getBlockInfoAtCoords(editor, 0, 0);

    expect(info?.typeName).toBe('listItem');
    expect(info?.node.textContent).toBe('item');
  });

  it('resolves a nested callout from its own icon rail', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{
        type: 'callout',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'outer' }] },
          {
            type: 'callout',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'inner' }] }],
          },
        ],
      }],
    });
    const callouts = editor.view.dom.querySelectorAll('.flowix-callout');
    expect(callouts).toHaveLength(2);
    pointAt(callouts[1].querySelector('.flowix-callout-icon'));

    const info = getBlockInfoAtCoords(editor, 0, 0);

    expect(info?.typeName).toBe('callout');
    expect(info?.node.textContent).toBe('inner');
  });
});
