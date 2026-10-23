import { Editor, type JSONContent } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createMarkdownEditorExtensions } from '../../markdown-editor-extensions';
import {
  addColumnBesideBlock,
  canSplitBlockToColumns,
  deleteColumn,
  deleteColumnAt,
  findColumnContainer,
  insertColumn,
  insertColumnAtSide,
  resolveColumnResize,
  setColumnWidths,
  splitBlockToColumns,
  splitBlocksIntoColumns,
} from './columns-commands';

const editors: Editor[] = [];

function createEditor(content: JSONContent): Editor {
  const editor = new Editor({
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

afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()));

function paragraphs(...texts: string[]): JSONContent {
  return {
    type: 'doc',
    content: texts.map((text) => ({
      type: 'paragraph',
      content: [{ type: 'text', text }],
    })),
  };
}

function docContent(editor: Editor): JSONContent[] {
  return editor.getJSON().content ?? [];
}

/** The editor's trailing-node plugin appends an empty paragraph after a transaction. */
function visibleContent(editor: Editor): JSONContent[] {
  const content = [...docContent(editor)];
  while (content.length > 0) {
    const last = content[content.length - 1];
    if (last.type !== 'paragraph' || (last.content?.length ?? 0) > 0) break;
    content.pop();
  }
  return content;
}

function columnsOf(editor: Editor): JSONContent | undefined {
  return docContent(editor).find((node) => node.type === 'columns');
}

function columnTexts(editor: Editor): string[][] {
  const columns = columnsOf(editor);
  return (columns?.content ?? []).map((column) => (
    (column.content ?? []).map((node) => {
      const parts: string[] = [];
      const visit = (current: JSONContent) => {
        if (typeof current.text === 'string') parts.push(current.text);
        (current.content ?? []).forEach(visit);
      };
      visit(node);
      return parts.join('');
    })
  ));
}

describe('columns commands', () => {
  it('splits a block and its right sibling into two columns', () => {
    const editor = createEditor(paragraphs('A', 'B'));
    expect(canSplitBlockToColumns(editor, 0)).toBe(true);
    expect(splitBlockToColumns(editor, 0)).toBe(true);

    expect(columnsOf(editor)).toBeDefined();
    expect(columnTexts(editor)).toEqual([['A'], ['B']]);
  });

  it('creates an empty right column when the block is last', () => {
    const editor = createEditor(paragraphs('A'));
    expect(splitBlockToColumns(editor, 0)).toBe(true);
    expect(columnTexts(editor)).toEqual([['A'], ['']]);
  });

  it('refuses to split a block that already lives in a column', () => {
    const editor = createEditor(paragraphs('A', 'B'));
    splitBlockToColumns(editor, 0);
    const columnPos = 2; // inside the first column's first paragraph
    expect(canSplitBlockToColumns(editor, columnPos)).toBe(false);
  });

  it('inserts up to five columns and then refuses', () => {
    const editor = createEditor(paragraphs('A', 'B'));
    splitBlockToColumns(editor, 0);

    expect(insertColumn(editor, 0)).toBe(true);
    expect(insertColumn(editor, 0)).toBe(true);
    expect(insertColumn(editor, 0)).toBe(true);
    expect(columnsOf(editor)!.content).toHaveLength(5);
    expect(columnsOf(editor)!.content!.map((column) => column.attrs?.width))
      .toEqual([100, 100, 100, 100, 100]);

    expect(insertColumn(editor, 0)).toBe(false);
    expect(columnsOf(editor)!.content).toHaveLength(5);
  });

  it('hoists the content of a deleted column after the container', () => {
    const editor = createEditor(paragraphs('A', 'B'));
    splitBlockToColumns(editor, 0);
    insertColumn(editor, 0); // A | B | empty

    expect(deleteColumn(editor, 0, 0)).toBe(true);
    expect(columnsOf(editor)!.content).toHaveLength(2);
    expect(columnTexts(editor)).toEqual([['B'], ['']]);

    const hoisted = docContent(editor)[1];
    expect(hoisted.type).toBe('paragraph');
    expect(JSON.stringify(hoisted)).toContain('A');
  });

  it('dissolves the container when only one column remains', () => {
    const editor = createEditor(paragraphs('A', 'B'));
    splitBlockToColumns(editor, 0);

    expect(deleteColumn(editor, 0, 0)).toBe(true);
    expect(columnsOf(editor)).toBeUndefined();
    expect(visibleContent(editor)).toHaveLength(1);
    expect(JSON.stringify(visibleContent(editor)[0])).toContain('B');
  });

  it('updates column widths', () => {
    const editor = createEditor(paragraphs('A', 'B'));
    splitBlockToColumns(editor, 0);

    expect(setColumnWidths(editor, 0, [150, 50])).toBe(true);
    expect(columnsOf(editor)!.content!.map((column) => column.attrs?.width)).toEqual([150, 50]);
    expect(setColumnWidths(editor, 0, [150, 50])).toBe(false);
  });

  it('finds the column container of a block', () => {
    const editor = createEditor(paragraphs('A', 'B'));
    splitBlockToColumns(editor, 0);

    const info = findColumnContainer(editor.state.doc, 2);
    expect(info).not.toBeNull();
    expect(info!.columnIndex).toBe(0);
    expect(info!.columnsNode.type.name).toBe('columns');
  });

  it('splits three consecutive blocks into three columns', () => {
    const editor = createEditor(paragraphs('A', 'B', 'C'));
    expect(splitBlocksIntoColumns(editor, 0, 3)).toBe(true);
    expect(columnTexts(editor)).toEqual([['A'], ['B'], ['C']]);
  });

  it('distributes selected block ranges into two columns', () => {
    const editor = createEditor(paragraphs('A', 'B', 'C'));
    const ranges = [
      { from: 0, to: 3 },
      { from: 3, to: 6 },
      { from: 6, to: 9 },
    ];
    expect(splitBlocksIntoColumns(editor, 0, 2, ranges)).toBe(true);
    expect(columnTexts(editor)).toEqual([['A', 'B'], ['C']]);
  });

  it('inserts a column on either side of the current column', () => {
    const leftEditor = createEditor(paragraphs('A', 'B'));
    splitBlockToColumns(leftEditor, 0);
    expect(insertColumnAtSide(leftEditor, 1, 'left')).toBe(true);
    expect(columnTexts(leftEditor)).toEqual([[''], ['A'], ['B']]);

    const rightEditor = createEditor(paragraphs('A', 'B'));
    splitBlockToColumns(rightEditor, 0);
    expect(insertColumnAtSide(rightEditor, 1, 'right')).toBe(true);
    expect(columnTexts(rightEditor)).toEqual([['A'], [''], ['B']]);
  });

  it('deletes a column by its position and dissolves the last pair', () => {
    const editor = createEditor(paragraphs('A', 'B'));
    splitBlockToColumns(editor, 0);

    expect(deleteColumnAt(editor, 1)).toBe(true);
    expect(columnsOf(editor)).toBeUndefined();
    expect(JSON.stringify(visibleContent(editor))).toContain('B');
  });

  it('adds an empty column beside a top-level block without moving its neighbour', () => {
    const editor = createEditor(paragraphs('A', 'B'));
    expect(addColumnBesideBlock(editor, 0)).toBe(true);

    expect(columnTexts(editor)).toEqual([['A'], ['']]);
    // B stays below the new columns block instead of being pulled into it.
    const content = editor.getJSON().content ?? [];
    expect(JSON.stringify(content[1])).toContain('B');
  });

  it('adds an empty column beside a block inside an existing container', () => {
    const editor = createEditor(paragraphs('A', 'B'));
    splitBlockToColumns(editor, 0); // A | B

    // First paragraph inside the first column.
    expect(addColumnBesideBlock(editor, 2)).toBe(true);
    expect(columnsOf(editor)!.content).toHaveLength(3);
    expect(columnTexts(editor)).toEqual([['A'], [''], ['B']]);
  });

  it('refuses to add a sixth column beside a block', () => {
    const editor = createEditor(paragraphs('A', 'B'));
    splitBlockToColumns(editor, 0);
    insertColumn(editor, 0);
    insertColumn(editor, 0);
    insertColumn(editor, 0);
    expect(columnsOf(editor)!.content).toHaveLength(5);

    expect(addColumnBesideBlock(editor, 2)).toBe(false);
    expect(columnsOf(editor)!.content).toHaveLength(5);
  });

  it('splits a single block into five columns with empty columns after the first', () => {
    const editor = createEditor(paragraphs('A', 'B'));
    expect(splitBlocksIntoColumns(editor, 0, 5, undefined, { onlyTarget: true })).toBe(true);
    expect(columnsOf(editor)!.content).toHaveLength(5);
    expect(columnTexts(editor)).toEqual([['A'], [''], [''], [''], ['']]);
    expect(JSON.stringify(visibleContent(editor)[1])).toContain('B');
  });

  it('renders the container and column NodeViews', () => {
    const editor = createEditor(paragraphs('A', 'B'));
    splitBlockToColumns(editor, 0);

    const dom = editor.view.dom;
    expect(dom.querySelectorAll('.flowix-columns')).toHaveLength(1);
    expect(dom.querySelectorAll('.flowix-column')).toHaveLength(2);
    expect(dom.querySelectorAll('.flowix-column-content')).toHaveLength(2);
    expect(dom.querySelector('.flowix-columns-add')).not.toBeNull();

    const handles = Array.from(dom.querySelectorAll<HTMLElement>('.flowix-column-resize-handle'));
    expect(handles).toHaveLength(2);
    // Only a column with a right neighbour can be resized; the last one has no handle.
    expect(handles[0].hidden).toBe(false);
    expect(handles[1].hidden).toBe(true);
    expect(dom.querySelectorAll<HTMLElement>('.flowix-column-remove')[0].hidden).toBe(false);
  });

  it('exports the columns structure as HTML', () => {
    const editor = createEditor(paragraphs('A', 'B'));
    splitBlockToColumns(editor, 0);

    const html = editor.getHTML();
    expect(html).toContain('data-flowix-columns');
    expect(html).toContain('flowix-column-content');
    expect(html).toContain('flex-grow: 100');
  });

  it('splits only the dragged pair and keeps the total width', () => {
    const widths = [100, 100, 100];
    const next = resolveColumnResize(widths, 0, 50, 300);
    expect(next[0] + next[1]).toBe(200);
    expect(next[2]).toBe(100);
    expect(next[0]).toBeGreaterThan(100);

    const clamped = resolveColumnResize(widths, 0, 10_000, 300);
    expect(clamped[0]).toBe(200 - 25);
    expect(clamped[1]).toBe(25);
  });
});
