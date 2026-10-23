import { Editor, type JSONContent } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMarkdownEditorExtensions,
  serializeEditorMarkdown,
} from '../../markdown-editor-extensions';
import { createMarkdownParserExtensions } from '../../markdown-parser-extensions';
import { normalizeColumnWidth } from './columns-markdown';

const editors: Editor[] = [];

function createEditor(content: string | JSONContent): Editor {
  const editor = new Editor({
    extensions: createMarkdownEditorExtensions({
      getOwnerPath: () => undefined,
      getAttachmentNotebookId: () => undefined,
      workspaceHost: 'main-third',
      getPlaceholder: () => '',
      getHeadingFoldLabels: () => ({ fold: '', unfold: '' }),
    }),
    content,
    contentType: typeof content === 'string' ? 'markdown' : 'json',
  });
  editors.push(editor);
  return editor;
}

afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()));

function blocksOf(editor: Editor): JSONContent[] {
  return editor.getJSON().content ?? [];
}

function columnsOf(editor: Editor): JSONContent | undefined {
  return blocksOf(editor).find((node) => node.type === 'columns');
}

function textOf(node: JSONContent | undefined): string {
  if (!node) return '';
  if (typeof node.text === 'string') return node.text;
  return (node.content ?? []).map(textOf).join('');
}

/**
 * `setContent` runs the editor's trailing-node plugin, which appends an empty
 * paragraph when the document ends with a non-text block (our columns node).
 * The initial `new Editor({ content })` parse does not run that transaction.
 * The extra paragraph is editor chrome, not part of the saved structure.
 */
function withoutTrailingEmptyParagraph(json: JSONContent): JSONContent {
  const content = [...(json.content ?? [])];
  while (content.length > 0) {
    const last = content[content.length - 1];
    if (last.type !== 'paragraph' || (last.content?.length ?? 0) > 0) break;
    content.pop();
  }
  return { ...json, content };
}

function twoColumnSource(left = '左边', right = '右边'): string {
  return `::: columns

:::: column width=100

${left}

::::

:::: column width=100

${right}

::::

:::`;
}

describe('columns markdown', () => {
  it('parses a two-column block', () => {
    const editor = createEditor(twoColumnSource());
    const columns = columnsOf(editor);

    expect(columns).toBeDefined();
    expect(columns!.content).toHaveLength(2);
    expect(columns!.content!.map(textOf)).toEqual(['左边', '右边']);
    expect(columns!.content!.map((column) => column.attrs?.width)).toEqual([100, 100]);
  });

  it('round-trips a two-column block', () => {
    const editor = createEditor(twoColumnSource());
    const expected = editor.getJSON();

    const saved = serializeEditorMarkdown(editor);
    expect(saved).toContain('::: columns');
    expect(saved).toContain(':::: column width=100');

    editor.commands.setContent(saved, { contentType: 'markdown' });
    expect(withoutTrailingEmptyParagraph(editor.getJSON())).toEqual(expected);
  });

  it('parses columns through the worker parser registry', () => {
    const manager = new MarkdownManager({
      extensions: createMarkdownParserExtensions(),
      markedOptions: { gfm: true, breaks: true },
    });
    const document = manager.parse(twoColumnSource());
    const columns = document.content?.find((node) => node.type === 'columns');

    expect(columns).toBeDefined();
    expect(columns!.content).toHaveLength(2);
    expect(columns!.content!.map(textOf)).toEqual(['左边', '右边']);
  });

  it('parses and round-trips three columns', () => {
    const source = `::: columns

:::: column width=200

第一列

::::

:::: column width=100

第二列

::::

:::: column width=50

第三列

::::

:::`;
    const editor = createEditor(source);
    const columns = columnsOf(editor);

    expect(columns!.content).toHaveLength(3);
    expect(columns!.content!.map((column) => column.attrs?.width)).toEqual([200, 100, 50]);

    const expected = editor.getJSON();
    const saved = serializeEditorMarkdown(editor);
    editor.commands.setContent(saved, { contentType: 'markdown' });
    expect(withoutTrailingEmptyParagraph(editor.getJSON())).toEqual(expected);
    expect(columnsOf(editor)!.content).toHaveLength(3);
  });

  it('falls back to the default width for invalid values', () => {
    const editor = createEditor(twoColumnSource().replace('width=100\n\n左边', 'width=oops\n\n左边'));
    const columns = columnsOf(editor);
    expect(columns!.content![0].attrs?.width).toBe(100);
  });

  it('keeps lists inside a column', () => {
    const source = `::: columns

:::: column width=100

- 第一项
- 第二项

::::

:::: column width=100

正文

::::

:::`;
    const editor = createEditor(source);
    const columns = columnsOf(editor);
    expect(columns!.content![0].content!.some((node) => node.type === 'bulletList')).toBe(true);

    const saved = serializeEditorMarkdown(editor);
    editor.commands.setContent(saved, { contentType: 'markdown' });
    expect(columnsOf(editor)!.content![0].content!.some((node) => node.type === 'bulletList')).toBe(true);
  });

  it('leaves an unclosed container as ordinary blocks', () => {
    const source = `::: columns

:::: column width=100

没有闭合

::::
`;
    const editor = createEditor(source);
    expect(columnsOf(editor)).toBeUndefined();
    expect(textOf(editor.getJSON())).toContain('没有闭合');
  });

  it('does not treat other fenced divs as columns', () => {
    const editor = createEditor('::: note\n\n正文\n\n:::');
    expect(columnsOf(editor)).toBeUndefined();
    expect(textOf(editor.getJSON())).toContain('正文');
  });

  it('flattens nested columns instead of producing nested nodes', () => {
    const source = `::: columns

:::: column width=100

外层左

::: columns

:::: column width=100

内层

::::

:::: column width=100

内层右

::::

:::

::::

:::: column width=100

外层右

::::

:::`;
    const editor = createEditor(source);
    const columns = columnsOf(editor);

    expect(columns).toBeDefined();
    expect(columns!.content!.length).toBeGreaterThanOrEqual(2);
    expect(columns!.content!.length).toBeLessThanOrEqual(5);
    expect(columns!.content!.some((column) => column.content?.some((node) => node.type === 'columns'))).toBe(false);
    expect(textOf(columns)).toContain('外层左');
    expect(textOf(columns)).toContain('内层');
    expect(textOf(columns)).toContain('外层右');
  });

  it('normalizes widths into the supported range', () => {
    expect(normalizeColumnWidth(undefined)).toBe(100);
    expect(normalizeColumnWidth('abc')).toBe(100);
    expect(normalizeColumnWidth(1)).toBe(25);
    expect(normalizeColumnWidth(9999)).toBe(1000);
  });
});
