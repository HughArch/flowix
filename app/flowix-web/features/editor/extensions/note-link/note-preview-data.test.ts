import { describe, expect, it } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { jsonToPlainText, sanitizeNotePreviewText } from './note-preview-data';

describe('sanitizeNotePreviewText', () => {
  it('drops fenced-div / callout marker lines and keeps readable body text', () => {
    const raw = [
      '正文第一行。',
      '::: callout icon="⚡" color="blue"',
      '提示块内文字',
      ':::',
    ].join('\n');
    expect(sanitizeNotePreviewText(raw)).toBe('正文第一行。\n提示块内文字');
  });

  it('strips common inline markdown marks', () => {
    const raw = [
      '## 标题行',
      '> 引用行',
      '- [x] 待办项',
      '2. 有序项',
      '看 [链接文字](https://example.com/a) 与 ![图片说明](attachments/a.png) 和 **加粗**、`代码`、~~删除~~。',
    ].join('\n');
    expect(sanitizeNotePreviewText(raw)).toBe(
      '标题行\n引用行\n待办项\n有序项\n看 链接文字 与 图片说明 和 加粗、代码、删除。',
    );
  });

  it('drops block markers, comments, and separators', () => {
    const raw = [
      '---',
      '::webcard{"url":"https://a"}',
      '<!-- flowix:table-reference {"version":1} -->',
      '***',
      '正文',
    ].join('\n');
    expect(sanitizeNotePreviewText(raw)).toBe('正文');
  });

  it('collapses blank runs and trims the result', () => {
    expect(sanitizeNotePreviewText('\n\nA\n\n\n\nB\n\n')).toBe('A\nB');
    expect(sanitizeNotePreviewText('')).toBe('');
  });
});

describe('jsonToPlainText', () => {
  it('joins blocks with line breaks and keeps inline text', () => {
    const doc: JSONContent = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '计划' }] },
        { type: 'paragraph', content: [
          { type: 'text', text: '第一段', marks: [{ type: 'bold' }] },
          { type: 'hardBreak' },
          { type: 'text', text: '第二行' },
        ] },
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '条目一' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '条目二' }] }] },
          ],
        },
      ],
    };
    expect(jsonToPlainText(doc)).toBe('计划\n第一段\n第二行\n条目一\n条目二');
  });

  it('skips media nodes and caps the excerpt length', () => {
    const doc: JSONContent = {
      type: 'doc',
      content: [
        { type: 'image', attrs: { src: 'a.png' } },
        { type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(1000) }] },
      ],
    };
    const text = jsonToPlainText(doc);
    expect(text).not.toContain('a.png');
    expect(text.length).toBeLessThanOrEqual(400);
    expect(text.startsWith('xxx')).toBe(true);
  });

  it('returns empty for nullish input', () => {
    expect(jsonToPlainText(null)).toBe('');
    expect(jsonToPlainText(undefined)).toBe('');
    expect(jsonToPlainText({ type: 'doc' })).toBe('');
  });
});
