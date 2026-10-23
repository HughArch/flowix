import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TaskList } from '@tiptap/extension-task-list';
import { Markdown } from '@tiptap/markdown';
import { describe, expect, it } from 'vitest';
import { MarkdownHeading, MarkdownListItem, MarkdownParagraph, MarkdownTaskItem } from '../markdown-parser-common-extensions';
import { BlockSelectionExtension, setBlockSelection } from './block-selection';
import {
  collectFlowixBlockBackgroundTargets,
  getFlowixBlockBackground,
  setFlowixBlockBackground,
} from './flowix-block-background';

function createEditor(content: string, contentType: 'markdown' | 'html' = 'markdown') {
  return new Editor({
    extensions: [
      StarterKit.configure({
        heading: false,
        paragraph: false,
        listItem: false,
      }),
      MarkdownHeading.configure({ levels: [1, 2, 3, 4] }),
      MarkdownParagraph,
      MarkdownListItem,
      TaskList,
      MarkdownTaskItem.configure({ nested: true }),
      BlockSelectionExtension,
      Markdown,
    ],
    content,
    contentType,
  });
}

interface BlockJson {
  type?: string;
  attrs?: { flowixBg?: string | null };
  content?: BlockJson[];
}

/** First paragraph inside the first list item of a document. */
function firstListItemBlock(json: unknown): BlockJson | undefined {
  const document = json as { content?: BlockJson[] };
  return document.content?.[0]?.content?.[0]?.content?.[0];
}

describe('Flowix line background', () => {
  it('round-trips the block comment on paragraphs and headings', () => {
    const markdown = [
      'Some content<!-- flowix:block-bg {"bg":"red"} -->',
      '',
      '## Title<!-- flowix:block-bg {"bg":"blue"} -->',
    ].join('\n');
    const editor = createEditor(markdown);

    expect(editor.getJSON()).toMatchObject({
      content: [
        { type: 'paragraph', attrs: { flowixBg: 'red' } },
        { type: 'heading', attrs: { level: 2, flowixBg: 'blue' } },
      ],
    });
    expect(editor.getMarkdown()).toBe(markdown);

    editor.destroy();
  });

  it('paints the caret block and reads it back', () => {
    const editor = createEditor('<p>one</p><p>two</p>', 'html');
    editor.commands.setTextSelection(2);

    expect(setFlowixBlockBackground(editor, 'yellow')).toBe(true);
    expect(getFlowixBlockBackground(editor)).toBe('yellow');
    expect(editor.getJSON().content?.[0].attrs?.flowixBg).toBe('yellow');
    expect(editor.getJSON().content?.[1].attrs?.flowixBg).toBeUndefined();

    editor.destroy();
  });

  it('paints every paragraph touched by a text selection', () => {
    const editor = createEditor('<p>one</p><p>two</p><p>three</p>', 'html');
    const state = editor.state;
    const firstEnd = state.doc.child(0).nodeSize;
    const secondEnd = firstEnd + state.doc.child(1).nodeSize;

    editor.commands.setTextSelection({ from: 2, to: secondEnd - 1 });
    expect(collectFlowixBlockBackgroundTargets(editor.state)).toHaveLength(2);

    setFlowixBlockBackground(editor, 'green');
    const content = editor.getJSON().content ?? [];
    expect(content[0].attrs?.flowixBg).toBe('green');
    expect(content[1].attrs?.flowixBg).toBe('green');
    expect(content[2].attrs?.flowixBg).toBeUndefined();

    editor.destroy();
  });

  it('fans out across a drag-handle block selection', () => {
    const editor = createEditor('<p>one</p><p>two</p><p>three</p>', 'html');
    const doc = editor.state.doc;
    const secondPos = doc.child(0).nodeSize;
    const thirdPos = secondPos + doc.child(1).nodeSize;

    setBlockSelection(editor, [
      { from: secondPos, to: thirdPos },
    ], secondPos);

    expect(collectFlowixBlockBackgroundTargets(editor.state)).toHaveLength(1);
    expect(setFlowixBlockBackground(editor, 'purple')).toBe(true);

    const content = editor.getJSON().content ?? [];
    expect(content[0].attrs?.flowixBg).toBeUndefined();
    expect(content[1].attrs?.flowixBg).toBe('purple');
    expect(getFlowixBlockBackground(editor)).toBe('purple');

    editor.destroy();
  });

  it('round-trips a background inside a list item paragraph', () => {
    const markdown = '- item<!-- flowix:block-bg {"bg":"orange"} -->\n- two';
    const editor = createEditor(markdown);

    const document = editor.getJSON() as { content?: BlockJson[] };
    expect(document.content?.[0]?.type).toBe('bulletList');
    expect(firstListItemBlock(document)).toMatchObject({
      type: 'paragraph',
      attrs: { flowixBg: 'orange' },
    });
    expect(editor.getMarkdown()).toBe(markdown);

    editor.destroy();
  });

  it('round-trips a background inside a task item paragraph', () => {
    const markdown = '- [ ] task<!-- flowix:block-bg {"bg":"pink"} -->\n- [x] done';
    const editor = createEditor(markdown);

    const document = editor.getJSON() as { content?: BlockJson[] };
    expect(document.content?.[0]?.type).toBe('taskList');
    expect(firstListItemBlock(document)).toMatchObject({
      type: 'paragraph',
      attrs: { flowixBg: 'pink' },
    });
    expect(editor.getMarkdown()).toBe(markdown);

    editor.destroy();
  });

  it('parses an empty list item carrying a background comment', () => {
    const editor = createEditor('- &nbsp;<!-- flowix:block-bg {"bg":"gray"} -->');
    const document = editor.getJSON() as { content?: BlockJson[] };
    expect(document.content?.[0]?.type).toBe('bulletList');
    expect(firstListItemBlock(document)).toMatchObject({
      type: 'paragraph',
      attrs: { flowixBg: 'gray' },
    });

    editor.destroy();
  });

  it('renders the block attribute for the editor DOM', () => {
    const editor = createEditor('Some content<!-- flowix:block-bg {"bg":"cyan"} -->');

    expect(editor.view.dom.innerHTML).toContain('data-flowix-block-bg="cyan"');

    editor.destroy();
  });

  it('paints the drag-handle target instead of the caret block', () => {
    const editor = createEditor('<p>one</p><p>two</p>', 'html');
    const secondPos = editor.state.doc.child(0).nodeSize;
    editor.commands.setTextSelection(2);

    expect(setFlowixBlockBackground(editor, 'blue', { targetPos: secondPos })).toBe(true);

    const content = editor.getJSON().content ?? [];
    expect(content[0].attrs?.flowixBg).toBeUndefined();
    expect(content[1].attrs?.flowixBg).toBe('blue');

    editor.destroy();
  });

  it('clears the colour with null without touching sibling blocks', () => {
    const editor = createEditor('<p>one</p><p>two</p>', 'html');
    editor.commands.setTextSelection(2);
    setFlowixBlockBackground(editor, 'red');
    setFlowixBlockBackground(editor, null);

    expect(getFlowixBlockBackground(editor)).toBeNull();
    expect(editor.getJSON().content?.[0].attrs?.flowixBg).toBeNull();

    editor.destroy();
  });
});
