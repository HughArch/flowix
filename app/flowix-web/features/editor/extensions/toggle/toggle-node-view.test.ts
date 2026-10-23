import { Editor, type JSONContent } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createMarkdownEditorExtensions } from '../../markdown-editor-extensions';

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

function toggleDocument(open = true, withBody = true): JSONContent {
  const content: JSONContent[] = [{
    type: 'paragraph',
    content: [{ type: 'text', text: 'title' }],
  }];
  if (withBody) {
    content.push({
      type: 'paragraph',
      content: [{ type: 'text', text: 'body' }],
    });
  }
  return {
    type: 'doc',
    content: [{ type: 'toggle', attrs: { open }, content }],
  };
}

function toggleDom(editor: Editor): HTMLElement {
  const dom = editor.view.dom.querySelector('.flowix-toggle');
  if (!(dom instanceof HTMLElement)) throw new Error('missing toggle node view');
  return dom;
}

function chevron(editor: Editor): HTMLButtonElement {
  const button = editor.view.dom.querySelector('.flowix-toggle-chevron');
  if (!(button instanceof HTMLButtonElement)) throw new Error('missing toggle chevron');
  return button;
}

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy());
  document.body.innerHTML = '';
});

describe('toggle node view', () => {
  it('renders the expanded state', () => {
    const editor = createEditor(toggleDocument());

    expect(toggleDom(editor).dataset.open).toBe('true');
    expect(toggleDom(editor).dataset.foldable).toBe('true');
    expect(chevron(editor).getAttribute('aria-expanded')).toBe('true');
    expect(chevron(editor).dataset.folded).toBe('false');
  });

  it('collapses on chevron click and hides the body with a decoration', () => {
    const editor = createEditor(toggleDocument());

    chevron(editor).click();

    expect(editor.state.doc.firstChild!.attrs.open).toBe(false);
    expect(toggleDom(editor).dataset.open).toBe('false');
    expect(chevron(editor).getAttribute('aria-expanded')).toBe('false');
    expect(editor.view.dom.querySelectorAll('.is-toggle-collapsed-content')).toHaveLength(1);
  });

  it('expands again on the next chevron click', () => {
    const editor = createEditor(toggleDocument(false));

    expect(editor.view.dom.querySelectorAll('.is-toggle-collapsed-content')).toHaveLength(1);

    chevron(editor).click();

    expect(editor.state.doc.firstChild!.attrs.open).toBe(true);
    expect(editor.view.dom.querySelectorAll('.is-toggle-collapsed-content')).toHaveLength(0);
  });

  it('moves the caret out of the body when collapsing', () => {
    const editor = createEditor(toggleDocument());
    // Toggle open token at 0; title paragraph at 1 (nodeSize 7); body text at 9.
    editor.commands.setTextSelection(9);
    expect(editor.state.selection.$from.parent.textContent).toBe('body');

    chevron(editor).click();

    expect(editor.state.selection.$from.parent.textContent).toBe('title');
    expect(editor.state.selection.from).toBe(7);
  });

  it('auto-expands when the caret is moved into a collapsed body', () => {
    const editor = createEditor(toggleDocument(false));
    expect(editor.state.doc.firstChild!.attrs.open).toBe(false);

    editor.commands.setTextSelection(9);

    expect(editor.state.doc.firstChild!.attrs.open).toBe(true);
    expect(editor.view.dom.querySelectorAll('.is-toggle-collapsed-content')).toHaveLength(0);
  });

  it('creates the first body block when the chevron is clicked on an empty toggle', () => {
    const editor = createEditor(toggleDocument(true, false));

    expect(toggleDom(editor).dataset.foldable).toBe('false');

    chevron(editor).click();

    const toggle = editor.state.doc.firstChild!;
    expect(toggle.attrs.open).toBe(true);
    expect(toggle.childCount).toBe(2);
    expect(toggle.lastChild!.type.name).toBe('paragraph');
    expect(toggle.lastChild!.content.size).toBe(0);
    expect(editor.state.selection.$from.parent).toBe(toggle.lastChild);
  });

  it('unfolds when creating the first body block on a collapsed empty toggle', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{
        type: 'toggle',
        attrs: { open: false },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'title' }] }],
      }],
    });

    chevron(editor).click();

    const toggle = editor.state.doc.firstChild!;
    expect(toggle.attrs.open).toBe(true);
    expect(toggle.childCount).toBe(2);
    expect(editor.view.dom.querySelectorAll('.is-toggle-collapsed-content')).toHaveLength(0);
  });

  it('renders the whole-container background attribute', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{
        type: 'toggle',
        attrs: { open: true, flowixBg: 'yellow' },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'title' }] }],
      }],
    });

    expect(toggleDom(editor).getAttribute('data-flowix-block-bg')).toBe('yellow');
  });

  it('labels an empty title with the toggle placeholder', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{
        type: 'toggle',
        attrs: { open: true },
        content: [{ type: 'paragraph' }],
      }],
    });

    const content = editor.view.dom.querySelector('.flowix-toggle-content');
    expect(content?.getAttribute('data-title-placeholder')).toBeTruthy();
  });
});
