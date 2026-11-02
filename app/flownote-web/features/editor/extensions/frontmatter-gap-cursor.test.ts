import { afterEach, describe, expect, it } from 'vitest';
import { Editor, Node } from '@tiptap/core';
import type { JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { GapCursor } from '@tiptap/pm/gapcursor';
import { TextSelection } from '@tiptap/pm/state';
import Frontmatter, { selectEditableDocumentContent } from './frontmatter';
import { BlockGapCursor } from './block-gap-cursor';

const editors: Editor[] = [];

function createEditor(body: JSONContent[] = [{ type: 'card' }, { type: 'card' }]) {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [
      StarterKit.configure({ gapcursor: false, trailingNode: false }),
      Frontmatter,
      Node.create({ name: 'card', group: 'block', atom: true, selectable: false, renderHTML: () => ['section'] }),
      BlockGapCursor,
    ],
    content: { type: 'doc', content: [
      { type: 'frontmatter', attrs: { yamlContent: 'status: todo' } },
      ...body,
    ] },
  });
  editors.push(editor);
  return editor;
}

function selectGap(editor: Editor, pos: number) {
  editor.view.dispatch(editor.state.tr.setSelection(new GapCursor(editor.state.doc.resolve(pos))));
}

afterEach(() => editors.splice(0).forEach(editor => editor.destroy()));

describe('frontmatter gap cursor protection', () => {
  it('moves a gap before properties to the first body card without changing content', () => {
    const editor = createEditor();
    const before = editor.state.doc;
    selectGap(editor, 0);
    expect(editor.state.selection).toBeInstanceOf(GapCursor);
    expect(editor.state.selection.from).toBe(1);
    expect(editor.state.selection.empty).toBe(true);
    expect(editor.state.doc).toBe(before);
  });

  it('keeps keyboard navigation out of the property prefix while preserving body gaps', () => {
    const editor = createEditor();
    selectGap(editor, 1);
    editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(editor.state.selection).toBeInstanceOf(GapCursor);
    expect(editor.state.selection.from).toBe(1);
    editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(editor.state.selection).toBeInstanceOf(GapCursor);
    expect(editor.state.selection.from).toBe(2);
  });

  it('uses a collapsed text cursor when the body starts with a paragraph', () => {
    const editor = createEditor([{ type: 'paragraph', content: [{ type: 'text', text: 'Body' }] }]);
    selectGap(editor, 0);
    expect(editor.state.selection).toBeInstanceOf(TextSelection);
    expect(editor.state.selection.from).toBe(2);
    expect(editor.state.selection.empty).toBe(true);
  });

  it('preserves typing at the legal boundary after properties', () => {
    const editor = createEditor();
    selectGap(editor, 1);
    editor.view.someProp('handleTextInput', handler => handler(editor.view, 1, 1, 'Body', () => editor.state.tr));
    expect(editor.state.doc.firstChild?.type.name).toBe('frontmatter');
    expect(editor.state.doc.firstChild?.attrs.yamlContent).toBe('status: todo');
    expect(editor.state.doc.child(1).textContent).toBe('Body');
  });

  it('leaves a legal insertion position after a properties-only document', () => {
    const editor = createEditor([]);
    selectGap(editor, 0);
    expect(editor.state.selection).toBeInstanceOf(GapCursor);
    expect(editor.state.selection.from).toBe(1);
    expect(editor.state.doc.childCount).toBe(1);
  });

  it('preserves select-all behavior for the editable body', () => {
    const editor = createEditor([{ type: 'paragraph', content: [{ type: 'text', text: 'Body' }] }]);
    selectEditableDocumentContent(editor);
    expect(editor.state.selection.empty).toBe(false);
    expect(editor.state.selection.from).toBe(2);
    expect(editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to)).toBe('Body');
  });
});
