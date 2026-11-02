import { Editor, type JSONContent } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMarkdownEditorExtensions,
  serializeEditorMarkdown,
} from '../../markdown-editor-extensions';
import { createMarkdownParserExtensions } from '../../markdown-parser-extensions';
import { DEFAULT_CALLOUT_COLOR, DEFAULT_CALLOUT_ICON } from './callout-markdown';

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

function roundTrip(editor: Editor): JSONContent {
  const expected = withoutTrailingEmptyParagraph(editor.getJSON());
  const saved = serializeEditorMarkdown(editor);
  editor.commands.setContent(saved, { contentType: 'markdown' });
  return { expected, actual: withoutTrailingEmptyParagraph(editor.getJSON()), saved };
}

function calloutSource(attributes = '', body = '内容'): string {
  return `::: callout${attributes}\n\n${body}\n\n:::`;
}

describe('callout markdown', () => {
  it('parses a callout with icon and colour', () => {
    const editor = createEditor(calloutSource(' icon="⚠️" color="yellow"'));
    const callout = typeOf(editor, 'callout');

    expect(callout).toBeDefined();
    expect(callout!.attrs).toMatchObject({ icon: '⚠️', color: 'yellow' });
    expect(textOf(callout)).toBe('内容');
  });

  it('round-trips icon and colour', () => {
    const editor = createEditor(calloutSource(' icon="🚀" color="blue"'));
    const { expected, actual, saved } = roundTrip(editor);

    expect(saved).toContain('::: callout icon="🚀" color="blue"');
    expect(actual).toEqual(expected);
  });

  it('omits default attributes and restores them on parse', () => {
    const editor = createEditor(calloutSource());
    const callout = typeOf(editor, 'callout');
    expect(callout!.attrs).toMatchObject({
      icon: DEFAULT_CALLOUT_ICON,
      color: DEFAULT_CALLOUT_COLOR,
    });

    const { actual, expected, saved } = roundTrip(editor);
    expect(saved).toContain('::: callout\n');
    expect(saved).not.toContain('color=');
    expect(actual).toEqual(expected);
  });

  it('accepts attributes in any order and ignores invalid values', () => {
    const editor = createEditor(calloutSource(' color="not-a-colour" unknown="x" icon="🔥"'));
    const callout = typeOf(editor, 'callout');

    expect(callout!.attrs).toMatchObject({
      icon: '🔥',
      color: DEFAULT_CALLOUT_COLOR,
    });
  });

  it('escapes quotes in the icon', () => {
    const editor = createEditor(calloutSource(' icon="a\\"b"'));
    const callout = typeOf(editor, 'callout');
    expect(callout!.attrs?.icon).toBe('a"b');

    const { actual, expected } = roundTrip(editor);
    expect(actual).toEqual(expected);
  });

  it('parses an empty callout as one empty paragraph', () => {
    const editor = createEditor('::: callout\n\n:::');
    const callout = typeOf(editor, 'callout');

    expect(callout!.content).toHaveLength(1);
    expect(callout!.content![0]).toMatchObject({ type: 'paragraph' });
    expect(callout!.content![0].content ?? []).toHaveLength(0);

    const { actual, expected } = roundTrip(editor);
    expect(actual).toEqual(expected);
  });

  it('keeps multiple paragraphs and lists inside a callout', () => {
    const editor = createEditor(calloutSource(
      ' color="green"',
      '第一段\n\n第二段\n\n- 项目一\n- 项目二',
    ));
    const callout = typeOf(editor, 'callout');
    const types = (callout!.content ?? []).map((node) => node.type);

    expect(types).toEqual(['paragraph', 'paragraph', 'bulletList']);

    const { actual, expected } = roundTrip(editor);
    expect(actual).toEqual(expected);
  });

  it('round-trips a nested callout', () => {
    const source = [
      '::: callout icon="💡" color="yellow"',
      '',
      '外层',
      '',
      '::: callout icon="⚠️" color="red"',
      '',
      '内层',
      '',
      ':::',
      '',
      ':::',
    ].join('\n');
    const editor = createEditor(source);
    const outer = typeOf(editor, 'callout');
    const nested = (outer!.content ?? []).find((node) => node.type === 'callout');

    expect(nested).toBeDefined();
    expect(nested!.attrs).toMatchObject({ icon: '⚠️', color: 'red' });
    expect(textOf(nested)).toBe('内层');

    const { actual, expected } = roundTrip(editor);
    expect(actual).toEqual(expected);
  });

  it('round-trips a callout nested inside columns', () => {
    const source = [
      '::: columns',
      '',
      ':::: column width=100',
      '',
      '::: callout color="blue"',
      '',
      '左',
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
    expect(columns!.content).toHaveLength(2);
    const left = columns!.content![0].content ?? [];
    expect(left.map((node) => node.type)).toEqual(['callout']);

    const { actual, expected } = roundTrip(editor);
    expect(actual).toEqual(expected);
  });

  it('round-trips columns nested inside a callout', () => {
    const source = [
      '::: callout color="purple"',
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
    const callout = typeOf(editor, 'callout');
    const columns = (callout!.content ?? []).find((node) => node.type === 'columns');

    expect(columns).toBeDefined();
    expect(columns!.content).toHaveLength(2);

    const { actual, expected } = roundTrip(editor);
    expect(actual).toEqual(expected);
  });

  it('ignores ::: inside code fences', () => {
    const source = calloutSource('', '```\n:::\n```');
    const editor = createEditor(source);
    const callout = typeOf(editor, 'callout');

    expect(callout).toBeDefined();
    expect((callout!.content ?? [])[0].type).toBe('codeBlock');

    const { actual, expected } = roundTrip(editor);
    expect(actual).toEqual(expected);
  });

  it('falls back to ordinary paragraphs when the fence is unclosed', () => {
    const editor = createEditor('::: callout\n\n内容');
    expect(typeOf(editor, 'callout')).toBeUndefined();
  });

  it('parses callouts through the worker parser registry', () => {
    const manager = new MarkdownManager({
      extensions: createMarkdownParserExtensions(),
      markedOptions: { gfm: true, breaks: true },
    });
    const document = manager.parse(calloutSource(' icon="📌" color="cyan"', '工人'));
    const callout = document.content?.find((node) => node.type === 'callout');

    expect(callout).toBeDefined();
    expect(callout!.attrs).toMatchObject({ icon: '📌', color: 'cyan' });
    expect(textOf(callout)).toBe('工人');
  });

  it('round-trips a callout inside a list item', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [{
          type: 'listItem',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: '外层' }] },
            {
              type: 'callout',
              attrs: { icon: '💡', color: 'green' },
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: '列表内' }],
                },
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: '第二段' }],
                },
              ],
            },
          ],
        }],
      }],
    });

    const { actual, expected, saved } = roundTrip(editor);
    expect(saved).toContain('::: callout color="green"');
    expect(actual).toEqual(expected);
  });

  it('round-trips a callout inside a blockquote', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{
        type: 'blockquote',
        content: [{
          type: 'callout',
          attrs: { icon: '⚠️', color: 'red' },
          content: [{
            type: 'paragraph',
            content: [{ type: 'text', text: '引用内' }],
          }],
        }],
      }],
    });

    const { actual, expected } = roundTrip(editor);
    expect(actual).toEqual(expected);
  });
});
