import { Editor, type JSONContent } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createMarkdownEditorExtensions } from '../../markdown-editor-extensions';
import {
  getFlowixBlockBackground,
  hasFlowixBlockBackgroundTargets,
  setFlowixBlockBackground,
} from '../flowix-block-background';

const editors: Editor[] = [];

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

function toggleDocument(): JSONContent {
  return {
    type: 'doc',
    content: [{
      type: 'toggle',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'title' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'body' }] },
      ],
    }],
  };
}

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy());
  document.body.innerHTML = '';
});

describe('toggle background', () => {
  it('paints the whole container through the drag-handle target', () => {
    const editor = createEditor(toggleDocument());

    expect(hasFlowixBlockBackgroundTargets(editor, { targetPos: 0 })).toBe(true);
    expect(setFlowixBlockBackground(editor, 'yellow', { targetPos: 0 })).toBe(true);

    const toggle = editor.state.doc.firstChild!;
    expect(toggle.attrs.flowixBg).toBe('yellow');
    // The inner rows keep their own background unset: the container paints it.
    expect(toggle.firstChild!.attrs.flowixBg).toBeUndefined();
    expect(toggle.lastChild!.attrs.flowixBg).toBeUndefined();

    expect(getFlowixBlockBackground(editor, { targetPos: 0 })).toBe('yellow');
    expect(
      editor.view.dom.querySelector('.flowix-toggle')?.getAttribute('data-flowix-block-bg'),
    ).toBe('yellow');
  });

  it('clears the container background', () => {
    const editor = createEditor(toggleDocument());

    setFlowixBlockBackground(editor, 'green', { targetPos: 0 });
    expect(setFlowixBlockBackground(editor, null, { targetPos: 0 })).toBe(true);

    expect(editor.state.doc.firstChild!.attrs.flowixBg).toBeNull();
    expect(
      editor.view.dom.querySelector('.flowix-toggle')?.getAttribute('data-flowix-block-bg'),
    ).toBeNull();
  });
});
