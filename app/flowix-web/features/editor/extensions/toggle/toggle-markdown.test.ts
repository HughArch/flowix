import { Editor, type JSONContent } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMarkdownEditorExtensions,
  serializeEditorMarkdown,
} from '../../markdown-editor-extensions';
import { TOGGLE_NODE_NAME } from './toggle-markdown';

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

function typeOf(editor: Editor, type: string): JSONContent | undefined {
  return blocksOf(editor).find((node) => node.type === type);
}

function textOf(node: JSONContent | undefined): string {
  if (!node) return '';
  if (typeof node.text === 'string') return node.text;
  return (node.content ?? []).map(textOf).join('');
}

/**
 * `setContent` runs the trailing-node plugin, which appends an empty paragraph
 * when the document ends with a non-text block. That paragraph is editor
 * chrome, not part of the saved Markdown.
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

function roundTrip(editor: Editor): { expected: JSONContent; actual: JSONContent; saved: string } {
  const expected = withoutTrailingEmptyParagraph(editor.getJSON());
  const saved = serializeEditorMarkdown(editor);
  editor.commands.setContent(saved, { contentType: 'markdown' });
  return { expected, actual: withoutTrailingEmptyParagraph(editor.getJSON()), saved };
}

function toggleSource(attributes = '', body = '标题\n\n正文'): string {
  return `::: toggle${attributes}\n\n${body}\n\n:::`;
}

describe('toggle markdown', () => {
  it('parses an expanded toggle with a title and body blocks', () => {
    const editor = createEditor(toggleSource());
    const toggle = typeOf(editor, TOGGLE_NODE_NAME);

    expect(toggle).toBeDefined();
    expect(toggle!.attrs).toMatchObject({ open: true });
    expect((toggle!.content ?? []).map((node) => node.type)).toEqual(['paragraph', 'paragraph']);
    expect(textOf(toggle)).toBe('标题正文');
  });

  it('parses the collapsed flag', () => {
    const editor = createEditor(toggleSource(' collapsed'));
    const toggle = typeOf(editor, TOGGLE_NODE_NAME);

    expect(toggle!.attrs).toMatchObject({ open: false });
  });

  it('round-trips the expanded state without writing the flag', () => {
    const editor = createEditor(toggleSource());
    const { actual, expected, saved } = roundTrip(editor);

    expect(saved).toContain('::: toggle\n');
    expect(saved).not.toContain('collapsed');
    expect(actual).toEqual(expected);
  });

  it('round-trips the collapsed state', () => {
    const editor = createEditor(toggleSource(' collapsed'));
    const { actual, expected, saved } = roundTrip(editor);

    expect(saved).toContain('::: toggle collapsed');
    expect(actual).toEqual(expected);
  });

  it('ignores unknown flags', () => {
    const editor = createEditor(toggleSource(' unknown="x" collapsed'));
    const toggle = typeOf(editor, TOGGLE_NODE_NAME);

    expect(toggle!.attrs).toMatchObject({ open: false });

    const { actual, expected, saved } = roundTrip(editor);
    expect(saved).toContain('::: toggle collapsed');
    expect(actual).toEqual(expected);
  });

  it('parses and round-trips the container background', () => {
    const editor = createEditor(toggleSource(' bg="yellow"'));
    const toggle = typeOf(editor, TOGGLE_NODE_NAME);

    expect(toggle!.attrs).toMatchObject({ open: true, flowixBg: 'yellow' });

    const { actual, expected, saved } = roundTrip(editor);
    expect(saved).toContain('bg="yellow"');
    expect(actual).toEqual(expected);
  });

  it('drops an invalid background', () => {
    const editor = createEditor(toggleSource(' bg="not-a-colour"'));
    const toggle = typeOf(editor, TOGGLE_NODE_NAME);

    expect(toggle!.attrs?.flowixBg).toBeUndefined();

    const { actual, expected, saved } = roundTrip(editor);
    expect(saved).not.toContain('bg=');
    expect(actual).toEqual(expected);
  });

  it('round-trips collapsed and background flags together', () => {
    const editor = createEditor(toggleSource(' collapsed bg="blue"'));
    const { actual, expected, saved } = roundTrip(editor);

    expect(saved).toContain('::: toggle collapsed bg="blue"');
    expect(actual).toEqual(expected);
  });

  it('parses an empty toggle as one empty paragraph', () => {
    const editor = createEditor('::: toggle\n\n:::');
    const toggle = typeOf(editor, TOGGLE_NODE_NAME);

    expect(toggle!.content).toHaveLength(1);
    expect(toggle!.content![0]).toMatchObject({ type: 'paragraph' });
    expect(toggle!.content![0].content ?? []).toHaveLength(0);

    const { actual, expected } = roundTrip(editor);
    expect(actual).toEqual(expected);
  });

  it('keeps multiple paragraphs and lists in the body', () => {
    const editor = createEditor(toggleSource(
      '',
      '标题\n\n第一段\n\n- 项目一\n- 项目二',
    ));
    const toggle = typeOf(editor, TOGGLE_NODE_NAME);
    const types = (toggle!.content ?? []).map((node) => node.type);

    expect(types).toEqual(['paragraph', 'paragraph', 'bulletList']);

    const { actual, expected } = roundTrip(editor);
    expect(actual).toEqual(expected);
  });

  it('round-trips a nested toggle', () => {
    const source = [
      '::: toggle',
      '',
      '外层',
      '',
      '::: toggle collapsed',
      '',
      '内层',
      '',
      ':::',
      '',
      ':::',
    ].join('\n');
    const editor = createEditor(source);
    const outer = typeOf(editor, TOGGLE_NODE_NAME);
    const nested = (outer!.content ?? []).find((node) => node.type === TOGGLE_NODE_NAME);

    expect(nested).toBeDefined();
    expect(nested!.attrs).toMatchObject({ open: false });
    expect(textOf(nested)).toBe('内层');

    const { actual, expected } = roundTrip(editor);
    expect(actual).toEqual(expected);
  });

  it('round-trips a toggle nested inside columns', () => {
    const source = [
      '::: columns',
      '',
      ':::: column width=100',
      '',
      '::: toggle',
      '',
      '左',
      '',
      '正文',
      '',
      ':::',
      '',
      '::::',
      '',
      ':::: column width=100',
      '',
      '右',
      '',
      '::::',
      '',
      ':::',
    ].join('\n');
    const editor = createEditor(source);
    const columns = typeOf(editor, 'columns');

    expect(columns).toBeDefined();
    const left = columns!.content![0].content ?? [];
    expect(left.map((node) => node.type)).toEqual([TOGGLE_NODE_NAME]);

    const { actual, expected } = roundTrip(editor);
    expect(actual).toEqual(expected);
  });

  it('round-trips columns nested inside a toggle', () => {
    const source = [
      '::: toggle',
      '',
      '标题',
      '',
      '::: columns',
      '',
      ':::: column width=100',
      '',
      '左',
      '',
      '::::',
      '',
      ':::: column width=100',
      '',
      '右',
      '',
      '::::',
      '',
      ':::',
      '',
      ':::',
    ].join('\n');
    const editor = createEditor(source);
    const toggle = typeOf(editor, TOGGLE_NODE_NAME);
    const nested = (toggle!.content ?? []).find((node) => node.type === 'columns');

    expect(nested).toBeDefined();

    const { actual, expected } = roundTrip(editor);
    expect(actual).toEqual(expected);
  });

  it('ignores fenced-div markers inside code fences', () => {
    const source = [
      '::: toggle',
      '',
      '标题',
      '',
      '```md',
      ':::',
      '::: toggle',
      '```',
      '',
      ':::',
    ].join('\n');
    const editor = createEditor(source);
    const toggle = typeOf(editor, TOGGLE_NODE_NAME);

    expect(toggle).toBeDefined();
    expect(textOf(toggle)).toContain('::: toggle');

    const { actual, expected } = roundTrip(editor);
    expect(actual).toEqual(expected);
  });

  it('leaves an unclosed toggle to the paragraph parser', () => {
    const editor = createEditor('::: toggle\n\n标题\n\n正文');
    const blocks = blocksOf(editor);

    expect(blocks.some((node) => node.type === TOGGLE_NODE_NAME)).toBe(false);
    expect(textOf({ type: 'doc', content: blocks })).toContain('::: toggle');
  });
});
