import { Editor } from '@tiptap/core';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it } from 'vitest';

import { createTablePlugin } from '@features/editor/extensions/table/table-plugin';
import { getTableTextAlign, setTableTextAlign } from '@features/editor/extensions/table/table-text-align';

const editors: Editor[] = [];

function createEditor(content: string): Editor {
  const editor = new Editor({
    extensions: [StarterKit, createTablePlugin(), Markdown],
    content,
    contentType: 'markdown',
  });
  editors.push(editor);
  return editor;
}

function cellAligns(editor: Editor): unknown[] {
  const aligns: unknown[] = [];
  editor.state.doc.firstChild?.descendants((node) => {
    if (node.type.name !== 'tableCell' && node.type.name !== 'tableHeader') return true;
    aligns.push(node.attrs.align);
    return false;
  });
  return aligns;
}

afterEach(() => {
  editors.splice(0).forEach(editor => editor.destroy());
});

describe('table text alignment', () => {
  it('reads the shared alignment from the markdown table', () => {
    const editor = createEditor([
      '| a | b |',
      '| :--- | :--- |',
      '| 1 | 2 |',
    ].join('\n'));

    expect(getTableTextAlign(editor.state.doc.firstChild!)).toBe('left');
  });

  it('returns null for mixed or missing alignment', () => {
    const mixed = createEditor([
      '| a | b |',
      '| :--- | ---: |',
      '| 1 | 2 |',
    ].join('\n'));
    const plain = createEditor([
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
    ].join('\n'));

    expect(getTableTextAlign(mixed.state.doc.firstChild!)).toBeNull();
    expect(getTableTextAlign(plain.state.doc.firstChild!)).toBeNull();
  });

  it('applies one alignment to every cell', () => {
    const editor = createEditor([
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
    ].join('\n'));

    expect(setTableTextAlign(editor, 0, 'center')).toBe(true);

    expect(cellAligns(editor)).toEqual(['center', 'center', 'center', 'center']);
    expect(getTableTextAlign(editor.state.doc.firstChild!)).toBe('center');
  });

  it('round-trips the alignment through markdown', () => {
    const editor = createEditor([
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
    ].join('\n'));

    setTableTextAlign(editor, 0, 'right');

    expect(editor.getMarkdown()).toMatch(/\|\s*-+:\s*\|\s*-+:\s*\|/);
    expect(getTableTextAlign(editor.state.doc.firstChild!)).toBe('right');
  });

  it('is a no-op when every cell already has that alignment', () => {
    const editor = createEditor([
      '| a | b |',
      '| :---: | :---: |',
      '| 1 | 2 |',
    ].join('\n'));

    expect(setTableTextAlign(editor, 0, 'center')).toBe(false);
  });

  it('rejects a stale position', () => {
    const editor = createEditor('plain text');
    expect(setTableTextAlign(editor, 0, 'center')).toBe(false);
  });
});
