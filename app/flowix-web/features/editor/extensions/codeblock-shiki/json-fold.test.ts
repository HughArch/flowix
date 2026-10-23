import { Editor } from '@tiptap/core';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it } from 'vitest';

import { CodeBlockShiki } from './codeblock-shiki';
import { JsonFoldExtension, jsonFoldPluginKey, toggleJsonFold } from './json-fold';

const JSON_TEXT = [
  '```json',
  '{',
  '  "a": {',
  '    "b": 1',
  '  }',
  '}',
  '```',
].join('\n');

const labels = { fold: 'Collapse', unfold: 'Expand' };
const editors: Editor[] = [];

function createEditor(markdown: string): Editor {
  const editor = new Editor({
    extensions: [
      StarterKit.configure({ codeBlock: false }),
      CodeBlockShiki,
      JsonFoldExtension.configure({ getLabels: () => labels }),
      Markdown,
    ],
    content: markdown,
    contentType: 'markdown',
  });
  editors.push(editor);
  return editor;
}

function foldState(editor: Editor) {
  return jsonFoldPluginKey.getState(editor.state);
}

function buttons(editor: Editor): HTMLElement[] {
  return Array.from(editor.view.dom.querySelectorAll<HTMLElement>('.json-fold-toggle'));
}

afterEach(() => {
  editors.splice(0).forEach(editor => editor.destroy());
});

describe('JSON fold decorations', () => {
  it('renders a toggle per foldable container', () => {
    const editor = createEditor(JSON_TEXT);

    expect(foldState(editor)?.folded.size).toBe(0);
    expect(buttons(editor)).toHaveLength(2);
    expect(buttons(editor)[0].dataset.folded).toBe('false');
  });

  it('skips non-json languages and invalid json', () => {
    const js = createEditor('```javascript\n{\n  a: 1\n}\n```');
    const invalid = createEditor('```json\n{\n  "a": 1,\n}\n```');

    expect(buttons(js)).toHaveLength(0);
    expect(buttons(invalid)).toHaveLength(0);
  });

  it('skips a code block that is collapsed as a whole', () => {
    const editor = createEditor('```json collapsed\n{\n  "a": 1\n}\n```');
    expect(buttons(editor)).toHaveLength(0);
  });

  it('hides the inner lines when folded', () => {
    const editor = createEditor(JSON_TEXT);
    const outerOpenPos = 1;

    expect(toggleJsonFold(editor.view, outerOpenPos)).toBe(true);

    expect(foldState(editor)?.folded.size).toBe(1);
    expect(foldState(editor)?.hidden).toHaveLength(1);
    expect(editor.view.dom.querySelectorAll('.json-fold-hidden')).toHaveLength(1);
    expect(buttons(editor)).toHaveLength(1);
    expect(buttons(editor)[0].dataset.folded).toBe('true');
  });

  it('unfolds when a selection enters the hidden range', () => {
    const editor = createEditor(JSON_TEXT);
    toggleJsonFold(editor.view, 1);
    expect(foldState(editor)?.folded.size).toBe(1);

    const hidden = foldState(editor)?.hidden[0];
    expect(hidden).toBeDefined();
    editor.commands.setTextSelection(hidden!.from + 1);

    expect(foldState(editor)?.folded.size).toBe(0);
  });

  it('keeps folds mapped to the block after document edits before it', () => {
    const editor = createEditor(JSON_TEXT);
    toggleJsonFold(editor.view, 1);

    editor.commands.insertContentAt(0, { type: 'paragraph', content: [{ type: 'text', text: 'intro' }] });

    expect(foldState(editor)?.folded.size).toBe(1);
    expect(editor.getMarkdown()).toContain('```json');
  });

  it('does not change the serialized markdown', () => {
    const editor = createEditor(JSON_TEXT);
    const before = editor.getMarkdown();
    toggleJsonFold(editor.view, 1);

    expect(editor.getMarkdown().trim()).toBe(before.trim());
  });

  it('drops folds when the json becomes invalid', () => {
    const editor = createEditor(JSON_TEXT);
    toggleJsonFold(editor.view, 1);
    expect(foldState(editor)?.folded.size).toBe(1);

    const blockPos = 0;
    const node = editor.state.doc.nodeAt(blockPos);
    editor.commands.command(({ tr }) => {
      tr.insertText(',', blockPos + 1 + node!.nodeSize - 2);
      return true;
    });

    expect(foldState(editor)?.folded.size).toBe(0);
    expect(buttons(editor)).toHaveLength(0);
  });
});
