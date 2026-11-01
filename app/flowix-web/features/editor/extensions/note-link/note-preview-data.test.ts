import { describe, expect, it } from 'vitest';
import { sanitizeNotePreviewText } from './note-preview-data';

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
