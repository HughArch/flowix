import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@features/editor/extensions/attachment-link/utils', () => ({
  assetUrl: (key: string) => `flownote-asset://${key}`,
  assetMarkdownUrl: (key: string) => `asset://${key}`,
  decodeStorageKey: (value: string) => value.replace(/^asset:\/\//, ''),
  isVideoUrl: (value: string) => value.endsWith('.mp4'),
}));

import { ImageAttachment } from './view-image';
import { VideoAttachment } from './view-video';

const editors: Editor[] = [];

function createEditor(content: string): Editor {
  const host = document.createElement('div');
  document.body.append(host);
  const editor = new Editor({
    element: host,
    extensions: [StarterKit, ImageAttachment, VideoAttachment, Markdown],
    content,
    contentType: 'markdown',
  });
  editors.push(editor);
  return editor;
}

afterEach(() => {
  editors.splice(0).forEach(editor => {
    const host = editor.view.dom.parentElement;
    editor.destroy();
    host?.remove();
  });
});

describe('media style metadata', () => {
  it('restores and serializes versioned image and video styles', () => {
    const editor = createEditor([
      '<!-- flownote:media {"flownote":"media","version":1,"style":{"widthPercent":60,"align":"right"}} -->',
      '![Photo](asset://photo.png)',
      '',
      '<!-- flownote:media {"flownote":"media","version":1,"style":{"align":"left"}} -->',
      '[Clip](asset://clip.mp4)',
    ].join('\n\n'));

    expect(editor.state.doc.child(0).attrs.widthPercent).toBe(60);
    expect(editor.state.doc.child(0).attrs.align).toBe('right');
    expect(editor.state.doc.child(2).attrs.align).toBe('left');

    const markdown = editor.getMarkdown();
    expect(markdown).toContain('<!-- flownote:media {"flownote":"media","version":1,"style":{"widthPercent":60,"align":"right"}} -->');
    expect(markdown).toContain('<!-- flownote:media {"flownote":"media","version":1,"style":{"align":"left"}} -->');
  });

  it('keeps reading the legacy image and video suffixes', () => {
    const editor = createEditor([
      '![Photo](asset://photo.png){width=50% align=left}',
      '[Clip](asset://clip.mp4){align=right}',
    ].join('\n\n'));

    expect(editor.state.doc.child(0).attrs.widthPercent).toBe(50);
    expect(editor.state.doc.child(0).attrs.align).toBe('left');
    expect(editor.state.doc.child(1).attrs.align).toBe('right');

    const markdown = editor.getMarkdown();
    expect(markdown).not.toContain('{width=50% align=left}');
    expect(markdown).not.toContain('{align=right}');
    expect(markdown).toContain('<!-- flownote:media {"flownote":"media","version":1,"style":{"widthPercent":50,"align":"left"}} -->');
    expect(markdown).toContain('<!-- flownote:media {"flownote":"media","version":1,"style":{"align":"right"}} -->');
  });

  it('migrates the previous trailing JSON format to a leading comment', () => {
    const editor = createEditor([
      '![Photo](asset://photo.png){"flownote":"media","version":1,"style":{"widthPercent":70}}',
      '[Clip](asset://clip.mp4){"flownote":"media","version":1,"style":{"align":"right"}}',
    ].join('\n\n'));

    expect(editor.state.doc.child(0).attrs.widthPercent).toBe(70);
    expect(editor.state.doc.child(1).attrs.align).toBe('right');
    expect(editor.getMarkdown()).toContain('<!-- flownote:media {"flownote":"media","version":1,"style":{"widthPercent":70}} -->');
    expect(editor.getMarkdown()).toContain('<!-- flownote:media {"flownote":"media","version":1,"style":{"align":"right"}} -->');
  });
});
