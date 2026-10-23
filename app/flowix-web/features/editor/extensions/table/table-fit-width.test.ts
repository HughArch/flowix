import { Editor } from '@tiptap/core';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it } from 'vitest';

import { createTablePlugin } from '@features/editor/extensions/table/table-plugin';
import { fitTableToWidth } from '@features/editor/extensions/table/table-fit-width';

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

const WIDTHS = [
  '<!-- flowix:table {"version":1,"columns":[{"width":120},{"width":240}]} -->',
  '| Name | Value |',
  '| --- | --- |',
  '| Alpha | Beta |',
].join('\n');

afterEach(() => {
  editors.splice(0).forEach(editor => editor.destroy());
});

describe('fitTableToWidth', () => {
  it('clears fixed column widths on every cell', () => {
    const editor = createEditor(WIDTHS);
    const firstRow = editor.state.doc.firstChild!.firstChild!;

    expect(firstRow.firstChild?.attrs.colwidth).toEqual([120]);
    expect(firstRow.child(1).attrs.colwidth).toEqual([240]);

    expect(fitTableToWidth(editor, 0)).toBe(true);

    const table = editor.state.doc.firstChild!;
    table.descendants((node) => {
      if (node.type.name !== 'tableCell' && node.type.name !== 'tableHeader') return true;
      expect(node.attrs.colwidth).toBeNull();
      return false;
    });
    expect(table.childCount).toBe(2);
  });

  it('drops the explicit widths from the markdown metadata', () => {
    const editor = createEditor(WIDTHS);
    fitTableToWidth(editor, 0);

    expect(editor.getMarkdown()).not.toContain('"width":120');
    expect(editor.getMarkdown()).not.toContain('"width":240');
    expect(editor.getMarkdown()).toMatch(/\|\s*Name\s*\|\s*Value\s*\|/);
  });

  it('is a no-op when the table has no fixed widths', () => {
    const editor = createEditor([
      '| Name | Value |',
      '| --- | --- |',
      '| Alpha | Beta |',
    ].join('\n'));

    expect(fitTableToWidth(editor, 0)).toBe(false);
  });

  it('rejects a stale position', () => {
    const editor = createEditor('plain text');
    expect(fitTableToWidth(editor, 0)).toBe(false);
  });
});
