import { Editor, type JSONContent } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createMarkdownEditorExtensions } from '../../markdown-editor-extensions';
import { dropBlockDragAtForView, startBlockDragForView } from '../block-drag';

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

function paragraph(text: string): JSONContent {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

function column(text: string, width = 100): JSONContent {
  return { type: 'column', attrs: { width }, content: [paragraph(text)] };
}

function docOf(...content: JSONContent[]): JSONContent {
  return { type: 'doc', content };
}

function columnsOf(editor: Editor): JSONContent | undefined {
  return (editor.getJSON().content ?? []).find((node) => node.type === 'columns');
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

function mockRect(element: Node | null, rect: Partial<DOMRect>): void {
  if (!element) throw new Error('Missing drop target DOM');
  const value = {
    left: 0,
    right: 200,
    top: 0,
    bottom: 100,
    width: 200,
    height: 100,
    x: 0,
    y: 0,
    toJSON: () => ({}),
    ...rect,
  };
  Object.defineProperty(element, 'getBoundingClientRect', { value: () => value, configurable: true });
}

function mockPosAtCoords(editor: Editor, pos: number): void {
  editor.view.posAtCoords = () => ({ pos, inside: -1 });
}

describe('columns drag and drop', () => {
  it('wraps two top-level blocks into columns at the right edge', () => {
    const editor = createEditor(docOf(paragraph('A'), paragraph('B')));
    const view = editor.view;
    const bPos = 3;

    mockPosAtCoords(editor, bPos + 1);
    mockRect(view.nodeDOM(bPos), { left: 0, right: 200, top: 0, bottom: 100, width: 200, height: 100 });

    expect(startBlockDragForView(view, { pos: 0, nodeSize: 3 })).toBe(true);
    expect(dropBlockDragAtForView(view, 195, 50)).toBe(true);

    // A was dropped to the right of B.
    expect(columnTexts(editor)).toEqual([['B'], ['A']]);
  });

  it('creates a new column at the edge of a column inside an existing container', () => {
    const editor = createEditor(docOf(
      paragraph('S'),
      { type: 'columns', content: [column('A'), column('B')] },
    ));
    const view = editor.view;
    // doc: S(0..3), columns(3), column A(4), paragraph A(5), column B(9), paragraph B(10)
    const columnAPos = 4;

    mockPosAtCoords(editor, 5);
    mockRect(view.nodeDOM(columnAPos), { left: 0, right: 200, top: 0, bottom: 100, width: 200, height: 100 });

    expect(startBlockDragForView(view, { pos: 0, nodeSize: 3 })).toBe(true);
    expect(dropBlockDragAtForView(view, 10, 50)).toBe(true);

    expect(columnsOf(editor)!.content).toHaveLength(3);
    expect(columnTexts(editor)).toEqual([['S'], ['A'], ['B']]);
  });

  it('does not create a sixth column', () => {
    const editor = createEditor(docOf(
      paragraph('S'),
      { type: 'columns', content: [column('A'), column('B'), column('C'), column('D'), column('E')] },
    ));
    const view = editor.view;

    mockPosAtCoords(editor, 5);
    mockRect(view.nodeDOM(4), { left: 0, right: 200, top: 0, bottom: 100, width: 200, height: 100 });

    expect(startBlockDragForView(view, { pos: 0, nodeSize: 3 })).toBe(true);
    expect(dropBlockDragAtForView(view, 10, 50)).toBe(true);

    expect(columnsOf(editor)!.content).toHaveLength(5);
  });

  it('inserts a block into the middle of another column', () => {
    const editor = createEditor(docOf(
      paragraph('S'),
      { type: 'columns', content: [column('A'), column('B')] },
    ));
    const view = editor.view;

    mockPosAtCoords(editor, 10);
    mockRect(view.nodeDOM(4), { left: 0, right: 200, top: 0, bottom: 100, width: 200, height: 100 });
    mockRect(view.nodeDOM(10), { left: 0, right: 200, top: 0, bottom: 100, width: 200, height: 100 });

    expect(startBlockDragForView(view, { pos: 0, nodeSize: 3 })).toBe(true);
    expect(dropBlockDragAtForView(view, 100, 40)).toBe(true);

    expect(columnsOf(editor)!.content).toHaveLength(2);
    expect(columnTexts(editor)).toEqual([['A'], ['S', 'B']]);
  });

  it('moves a block out of a column back to the document root', () => {
    const editor = createEditor(docOf(
      { type: 'columns', content: [column('A'), column('B')] },
      paragraph('T'),
    ));
    const view = editor.view;
    // doc: columns(0..12), column A(1), paragraph A(2), column B(6), paragraph B(7), T(12)
    const targetPos = 12;

    mockPosAtCoords(editor, targetPos);
    mockRect(view.nodeDOM(0), { left: 0, right: 200, top: 0, bottom: 100, width: 200, height: 100 });
    mockRect(view.nodeDOM(targetPos), { left: 0, right: 200, top: 100, bottom: 200, width: 200, height: 100 });

    // Drag paragraph A out of its column.
    expect(startBlockDragForView(view, { pos: 2, nodeSize: 3 })).toBe(true);
    expect(dropBlockDragAtForView(view, 100, 110)).toBe(true);

    // The empty source column is kept and filled with an empty paragraph.
    expect(columnTexts(editor)).toEqual([[''], ['B']]);
    const content = editor.getJSON().content ?? [];
    expect(content).toHaveLength(3);
    expect(JSON.stringify(content[1])).toContain('A');
  });

  it('moves several selected blocks together into a new column', () => {
    const editor = createEditor(docOf(
      paragraph('A'),
      paragraph('B'),
      { type: 'columns', content: [column('C'), column('D')] },
    ));
    const view = editor.view;
    // doc: A(0..3), B(3..6), columns(6), column C(7), paragraph C(8)
    const columnCPos = 7;

    mockPosAtCoords(editor, 8);
    mockRect(view.nodeDOM(columnCPos), { left: 0, right: 200, top: 0, bottom: 100, width: 200, height: 100 });

    expect(startBlockDragForView(view, { pos: 0, nodeSize: 3 }, [{ pos: 3, nodeSize: 3 }])).toBe(true);
    expect(dropBlockDragAtForView(view, 195, 50)).toBe(true);

    expect(columnsOf(editor)!.content).toHaveLength(3);
    expect(columnTexts(editor)).toEqual([['C'], ['A', 'B'], ['D']]);
  });

  it('wraps an ordinary paragraph into an ordered list dropped between items', () => {
    const editor = createEditor(docOf(
      paragraph('X'),
      {
        type: 'orderedList',
        attrs: { start: 1 },
        content: [
          { type: 'listItem', content: [paragraph('A')] },
          { type: 'listItem', content: [paragraph('B')] },
        ],
      },
    ));
    const view = editor.view;
    // doc: X(0..3), orderedList(3), listItem A(4), paragraph A(5),
    // listItem B(9), paragraph B(10)
    mockPosAtCoords(editor, 10);
    mockRect(view.nodeDOM(3), { left: 0, right: 200, top: 0, bottom: 100, width: 200, height: 100 });
    mockRect(view.nodeDOM(4), { left: 0, right: 200, top: 0, bottom: 50, width: 200, height: 50 });
    mockRect(view.nodeDOM(5), { left: 0, right: 200, top: 0, bottom: 50, width: 200, height: 50 });
    mockRect(view.nodeDOM(9), { left: 0, right: 200, top: 50, bottom: 100, width: 200, height: 50 });
    mockRect(view.nodeDOM(10), { left: 0, right: 200, top: 50, bottom: 100, width: 200, height: 50 });

    expect(startBlockDragForView(view, { pos: 0, nodeSize: 3 })).toBe(true);
    expect(dropBlockDragAtForView(view, 100, 60)).toBe(true);

    const list = (editor.getJSON().content ?? []).find((node) => node.type === 'orderedList');
    expect(list?.content).toHaveLength(3);
    expect(JSON.stringify(list?.content?.[1])).toContain('X');
  });
});
