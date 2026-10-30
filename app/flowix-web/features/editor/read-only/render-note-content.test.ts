import { describe, expect, it } from 'vitest';
import {
  listNoteHeadings,
  parseNoteMarkdown,
  renderNoteContentHtml,
  renderNoteMarkdownHtml,
  sliceNoteByHeading,
} from './render-note-content';

describe('sliceNoteByHeading', () => {
  const json = parseNoteMarkdown([
    '# Top',
    '',
    'intro',
    '',
    '## Target',
    '',
    'target body',
    '',
    '### Nested',
    '',
    'nested body',
    '',
    '## Next',
    '',
    'next body',
  ].join('\n'));

  it('extracts the heading and its subtree', () => {
    const slice = sliceNoteByHeading(json, 'Target');
    expect(slice).not.toBeNull();
    const html = renderNoteContentHtml({ type: 'doc', content: slice ?? [] });
    expect(html).toContain('<h2>Target</h2>');
    expect(html).toContain('target body');
    expect(html).toContain('nested body');
    expect(html).not.toContain('next body');
    expect(html).not.toContain('intro');
  });

  it('matches loosely around whitespace and case', () => {
    expect(sliceNoteByHeading(json, '  target ')).not.toBeNull();
  });

  it('returns null for a missing heading', () => {
    expect(sliceNoteByHeading(json, 'Nope')).toBeNull();
  });

  it('lists top-level headings in order with their level', () => {
    expect(listNoteHeadings(json)).toEqual([
      { level: 1, text: 'Top' },
      { level: 2, text: 'Target' },
      { level: 3, text: 'Nested' },
      { level: 2, text: 'Next' },
    ]);
  });
});

describe('renderNoteContentHtml', () => {
  it('renders callouts with icon rail and content wrapper', () => {
    const html = renderNoteMarkdownHtml('::: callout icon="💡" color="yellow"\n\nHello **world**\n\n:::');
    expect(html).toContain('class="flowix-callout"');
    expect(html).toContain('data-color="yellow"');
    expect(html).toContain('<span class="flowix-callout-icon" aria-hidden="true">💡</span>');
    expect(html).toContain('<div class="flowix-callout-content"><p>Hello <strong>world</strong></p></div>');
  });

  it('renders headings, task lists and tables', () => {
    const html = renderNoteMarkdownHtml([
      '## Title',
      '',
      '- [x] done',
      '- [ ] todo',
      '',
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
    ].join('\n'));
    expect(html).toContain('<h2>Title</h2>');
    expect(html).toContain('data-type="taskList"');
    expect(html).toContain('<table');
    expect(html).toContain('<th');
  });

  it('renders note references as chips carrying the anchor', () => {
    const html = renderNoteMarkdownHtml('[[Plan#Heading|alias]]');
    expect(html).toContain('data-note-ref="true"');
    expect(html).toContain('readonly-note-ref__title');
    expect(html).toContain('data-heading="Heading"');
  });

  it('resolves attachment image keys through the injected resolver', () => {
    // The editor's renderHTML calls Tauri's convertFileSrc; give the test
    // environment a stub so serialization succeeds outside the app shell.
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      convertFileSrc: (path: string) => `https://asset.localhost/${encodeURIComponent(path)}`,
    };
    const html = renderNoteMarkdownHtml('![alt](asset://localhost/attachments%2Fpic.png)', {
      notebookPath: '/vault/nb',
      resolveAttachmentUrl: (key) => `resolved://${key}`,
    });
    expect(html).toContain('src="resolved://attachments/pic.png"');
    expect(html).toContain('loading="lazy"');
  });

  it('drops frontmatter and unknown node types without failing', () => {
    const json = parseNoteMarkdown('---\ntags: [a]\n---\n\nbody');
    const html = renderNoteContentHtml({
      type: 'doc',
      content: [
        ...(json.content ?? []),
        { type: 'futureNode', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'kept' }] }] },
      ],
    });
    expect(html).not.toContain('frontmatter');
    expect(html).not.toContain('futureNode');
    expect(html).toContain('kept');
  });

  it('falls back to escaped plain text when serialization fails', () => {
    // The empty table is schema-known but content-invalid, forcing the
    // nodeFromJSON failure path; the paragraph's text must survive escaped.
    const html = renderNoteContentHtml({
      type: 'doc',
      content: [
        { type: 'table', content: [] },
        { type: 'paragraph', content: [{ type: 'text', text: '<b>text</b> & more' }] },
      ],
    });
    expect(html).not.toContain('<table');
    expect(html).toContain('&lt;b&gt;text&lt;/b&gt; &amp; more');
  });
});
