import { Editor } from '@tiptap/core';
import { Markdown, MarkdownManager } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it } from 'vitest';

import { createMarkdownParserExtensions } from '../../markdown-parser-extensions';
import {
  CodeBlockShikiBase,
  formatCodeBlockFenceInfo,
  parseCodeBlockFenceInfo,
} from './codeblock-shiki-base';
import { CodeBlockShiki } from './codeblock-shiki';
import { toggleCodeBlockCollapsed } from './codeblock-fold';

const editors: Editor[] = [];

function createEditor(markdown: string, interactive = false): Editor {
  const editor = new Editor({
    extensions: [
      StarterKit.configure({ codeBlock: false }),
      interactive ? CodeBlockShiki : CodeBlockShikiBase,
      Markdown,
    ],
    content: markdown,
    contentType: 'markdown',
  });
  editors.push(editor);
  return editor;
}

function codeBlockAt(editor: Editor) {
  return editor.state.doc.firstChild;
}

afterEach(() => {
  editors.splice(0).forEach(editor => editor.destroy());
});

describe('code block fence info', () => {
  it('splits the collapsed flag from the language', () => {
    expect(parseCodeBlockFenceInfo('json collapsed')).toEqual({ language: 'json', collapsed: true });
    expect(parseCodeBlockFenceInfo('collapsed')).toEqual({ language: null, collapsed: true });
    expect(parseCodeBlockFenceInfo('json {collapsed}')).toEqual({ language: 'json', collapsed: true });
    expect(parseCodeBlockFenceInfo('json')).toEqual({ language: 'json', collapsed: false });
    expect(parseCodeBlockFenceInfo('')).toEqual({ language: null, collapsed: false });
  });

  it('formats a bare flag for serialization', () => {
    expect(formatCodeBlockFenceInfo('json', true)).toBe('json collapsed');
    expect(formatCodeBlockFenceInfo(null, true)).toBe('collapsed');
    expect(formatCodeBlockFenceInfo('json', false)).toBe('json');
    expect(formatCodeBlockFenceInfo('', false)).toBe('');
  });
});

describe('code block collapsed markdown persistence', () => {
  it('restores the flag from a fenced code block', () => {
    const editor = createEditor('```json collapsed\n{"a":1}\n```');
    const node = codeBlockAt(editor);
    expect(node?.attrs.language).toBe('json');
    expect(node?.attrs.collapsed).toBe(true);
  });

  it('keeps plain fences unchanged', () => {
    const editor = createEditor('```json\n{"a":1}\n```');
    const node = codeBlockAt(editor);
    expect(node?.attrs.collapsed).toBe(false);
    expect(editor.getMarkdown()).not.toContain('collapsed');
  });

  it('round-trips a collapsed empty code block', () => {
    const editor = createEditor('```json collapsed\n\n```');
    expect(editor.getMarkdown()).toContain('```json collapsed');
    expect(editor.getMarkdown()).toContain('```');
  });

  it('serializes the flag back to the fence info', () => {
    const editor = createEditor('```json collapsed\n{"a":1}\n```');
    expect(editor.getMarkdown()).toContain('```json collapsed');
  });

  it('serializes a flag without a language', () => {
    const editor = createEditor('```collapsed\nbody\n```');
    const node = codeBlockAt(editor);
    expect(node?.attrs.language).toBeNull();
    expect(node?.attrs.collapsed).toBe(true);
    expect(editor.getMarkdown()).toContain('```collapsed');
  });

  it('restores the flag through the worker parser registry', () => {
    const manager = new MarkdownManager({
      extensions: createMarkdownParserExtensions(),
      markedOptions: { gfm: true, breaks: true },
    });

    const document = manager.parse('```json collapsed\n{"a":1}\n```');
    const code = (document.content ?? []).find(node => node.type === 'codeBlock');
    expect(code?.attrs).toMatchObject({ language: 'json', collapsed: true });
  });
});

describe('toggleCodeBlockCollapsed', () => {
  it('collapses the block and moves the caret out', () => {
    const editor = createEditor('```json\n{"a":1}\n```', true);
    const pos = 0;
    editor.commands.setTextSelection(3);

    expect(toggleCodeBlockCollapsed(editor.view, pos)).toBe(true);

    expect(codeBlockAt(editor)?.attrs.collapsed).toBe(true);
    expect(editor.state.selection.from).toBeGreaterThanOrEqual(codeBlockAt(editor)!.nodeSize);
  });

  it('expands a collapsed block on the next toggle', () => {
    const editor = createEditor('```json collapsed\n{"a":1}\n```', true);
    expect(toggleCodeBlockCollapsed(editor.view, 0)).toBe(true);
    expect(codeBlockAt(editor)?.attrs.collapsed).toBe(false);
  });

  it('re-expands when a selection enters the hidden content', () => {
    const editor = createEditor('```json collapsed\n{"a":1}\n```', true);
    expect(codeBlockAt(editor)?.attrs.collapsed).toBe(true);

    editor.commands.setTextSelection(3);

    expect(codeBlockAt(editor)?.attrs.collapsed).toBe(false);
  });
});
