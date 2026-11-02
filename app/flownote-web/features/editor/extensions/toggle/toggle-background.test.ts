import { Editor, type JSONContent } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createMarkdownEditorExtensions } from '../../markdown-editor-extensions';
import {
  getFlownoteBlockBackground,
  hasFlownoteBlockBackgroundTargets,
  setFlownoteBlockBackground,
} from '../flownote-block-background';

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

    expect(hasFlownoteBlockBackgroundTargets(editor, { targetPos: 0 })).toBe(true);
    expect(setFlownoteBlockBackground(editor, 'yellow', { targetPos: 0 })).toBe(true);

    const toggle = editor.state.doc.firstChild!;
    expect(toggle.attrs.flownoteBg).toBe('yellow');
    // The inner rows keep their own background unset: the container paints it.
    expect(toggle.firstChild!.attrs.flownoteBg).toBeUndefined();
    expect(toggle.lastChild!.attrs.flownoteBg).toBeUndefined();

    expect(getFlownoteBlockBackground(editor, { targetPos: 0 })).toBe('yellow');
    expect(
      editor.view.dom.querySelector('.flownote-toggle')?.getAttribute('data-flownote-block-bg'),
    ).toBe('yellow');
  });

  it('clears the container background', () => {
    const editor = createEditor(toggleDocument());

    setFlownoteBlockBackground(editor, 'green', { targetPos: 0 });
    expect(setFlownoteBlockBackground(editor, null, { targetPos: 0 })).toBe(true);

    expect(editor.state.doc.firstChild!.attrs.flownoteBg).toBeNull();
    expect(
      editor.view.dom.querySelector('.flownote-toggle')?.getAttribute('data-flownote-block-bg'),
    ).toBeNull();
  });
});
