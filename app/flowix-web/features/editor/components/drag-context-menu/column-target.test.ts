import { Editor, type JSONContent } from '@tiptap/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

function columnsDocument(left: string, right: string): JSONContent {
  return {
    type: 'doc',
    content: [{
      type: 'columns',
      content: [
        { type: 'column', attrs: { width: 100 }, content: [{ type: 'paragraph', content: [{ type: 'text', text: left }] }] },
        { type: 'column', attrs: { width: 100 }, content: [{ type: 'paragraph', content: [{ type: 'text', text: right }] }] },
      ],
    }],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.elementFromPoint = originalElementFromPoint;
  editors.splice(0).forEach((editor) => editor.destroy());
  document.body.innerHTML = '';
});

describe('column drag targets', () => {
  it('resolves the row from a column gutter even when posAtCoords lands on the container', () => {
    const editor = createEditor(columnsDocument('左', '右'));
    const columns = editor.view.dom.querySelectorAll('.flowix-column');
    expect(columns).toHaveLength(2);

    // Pointer on the second column's left padding (the 18px handle gutter).
    pointAt(columns[1].querySelector('.flowix-column-content'));
    // Simulate the bug: ProseMirror resolves the gutter to the `columns`
    // container, which has no visible block and therefore no handle.
    vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos: 0, inside: -1 });

    const info = getBlockInfoAtCoords(editor, 0, 0);

    expect(info?.typeName).toBe('paragraph');
    expect(info?.node.textContent).toBe('右');
  });

  it('resolves the row when hovering the first column padding', () => {
    const editor = createEditor(columnsDocument('左', '右'));
    const columns = editor.view.dom.querySelectorAll('.flowix-column');
    pointAt(columns[0].querySelector('.flowix-column-content'));

    const info = getBlockInfoAtCoords(editor, 0, 0);

    expect(info?.typeName).toBe('paragraph');
    expect(info?.node.textContent).toBe('左');
  });

  it('returns no target in the gap between columns', () => {
    const editor = createEditor(columnsDocument('左', '右'));
    // The flex container, not a column: there is no row to own a handle.
    pointAt(editor.view.dom.querySelector('.flowix-columns'));
    vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos: 0, inside: -1 });

    expect(getBlockInfoAtCoords(editor, 0, 0)).toBeNull();
  });
});
