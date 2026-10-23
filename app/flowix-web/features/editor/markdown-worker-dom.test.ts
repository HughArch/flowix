// @vitest-environment node
import { MarkdownManager } from '@tiptap/markdown';
import { afterAll, describe, expect, it } from 'vitest';
import { createMarkdownParserExtensions } from './markdown-parser-extensions';
import { installMarkdownWorkerDOM } from './markdown-worker-dom';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterAll(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

describe('HTML parsing without a browser DOM', () => {
  it('preserves HTML table cells, empty paragraphs and multiple cell paragraphs', () => {
    expect(typeof window).toBe('undefined');
    installMarkdownWorkerDOM();
    const manager = new MarkdownManager({ extensions: createMarkdownParserExtensions() });
    const empty = '<td colspan="1" rowspan="1"><p></p></td>';
    const header = '<th colspan="1" rowspan="1"><p></p></th>';
    const source = '<table style="min-width: 240px;"><colgroup>'
      + '<col style="min-width: 80px;">'.repeat(3) + '</colgroup><tbody>'
      + `<tr>${header.repeat(3)}</tr>`
      + `<tr><td colspan="1" rowspan="1"><p></p><p>哈哈好</p></td>${empty.repeat(2)}</tr>`
      + `<tr>${empty.repeat(3)}</tr></tbody></table>`;
    const doc = manager.parse(`Before\n\n${source}\n\nAfter`);
    const escapedSource = source.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    expect(manager.parse(`Before\n\n${escapedSource}\n\nAfter`)).toEqual(doc);
    expect(manager.parse('```html\n' + escapedSource + '\n```').content?.[0].type).toBe('codeBlock');
    expect(manager.parse('Example: ' + escapedSource).content?.[0].type).toBe('paragraph');
    const table = doc.content?.[1];
    expect(table?.type).toBe('table');
    expect(table?.content).toHaveLength(3);
    expect(table?.content?.map(row => row.content?.length)).toEqual([3, 3, 3]);
    expect(table?.content?.[0].content?.[0].type).toBe('tableHeader');
    expect(table?.content?.[1].content?.[0].content).toEqual([
      { type: 'paragraph', attrs: { flowixBg: undefined } },
      { type: 'paragraph', attrs: { flowixBg: undefined }, content: [{ type: 'text', text: '哈哈好' }] },
    ]);
    expect(doc.content?.[2].content?.[0].text).toBe('After');

    const merged = manager.parse('<table><tr><td colspan="2" rowspan="2" colwidth="120,80"><p><strong>A &amp; B</strong></p><p>next</p></td></tr></table>');
    const cell = merged.content?.[0].content?.[0].content?.[0];
    expect(cell?.attrs).toMatchObject({ colspan: 2, rowspan: 2, colwidth: [120, 80] });
    expect(cell?.content?.[0].content?.[0]).toEqual({
      type: 'text', text: 'A & B', marks: [{ type: 'bold' }],
    });
  });
});
