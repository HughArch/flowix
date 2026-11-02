import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { describe, expect, it } from 'vitest';
import {
  FLOWNOTE_TEXT_COLORS,
  FlownoteHighlight,
  normalizeFlownoteTextStyle,
} from './flownote-text-mark';

function createEditor(content: string) {
  return new Editor({
    extensions: [
      StarterKit,
      FlownoteHighlight.configure({ multicolor: true }),
      Markdown,
    ],
    content,
    contentType: 'markdown',
  });
}

describe('Flownote semantic highlight mark', () => {
  it('round-trips the semantic color comment format', () => {
    const markdown = '==阻塞发布的问题==<!-- flownote:text {"bg":"red","fg":"blue"} -->';
    const editor = createEditor(markdown);

    expect(editor.getJSON()).toMatchObject({
      content: [{
        content: [{
          text: '阻塞发布的问题',
          marks: [{
            type: 'highlight',
            attrs: {
              flownoteBg: 'red',
              flownoteFg: 'blue',
            },
          }],
        }],
      }],
    });
    expect(editor.getMarkdown()).toBe(markdown);

    editor.destroy();
  });

  it('keeps legacy highlight markdown readable and uncolored', () => {
    const editor = createEditor('==旧格式高亮==');

    expect(editor.getJSON()).toMatchObject({
      content: [{
        content: [{
          text: '旧格式高亮',
          marks: [{
            type: 'highlight',
            attrs: {
              flownoteBg: null,
              flownoteFg: null,
            },
          }],
        }],
      }],
    });
    expect(editor.getMarkdown()).toBe('==旧格式高亮==');

    editor.destroy();
  });

  it('canonicalizes the previous danger semantic aliases during migration', () => {
    const editor = createEditor('==阻塞发布的问题==<!-- flownote:text {"bg":"danger","fg":"on-danger"} -->');

    expect(editor.getMarkdown()).toBe(
      '==阻塞发布的问题==<!-- flownote:text {"bg":"red","fg":"red"} -->',
    );

    editor.destroy();
  });

  it('accepts only the nine stable semantic color names', () => {
    expect(FLOWNOTE_TEXT_COLORS).toEqual([
      'red', 'orange', 'yellow', 'green',
      'cyan', 'blue', 'purple', 'pink', 'gray',
    ]);
    expect(normalizeFlownoteTextStyle({ bg: 'purple', fg: 'gray' })).toEqual({
      bg: 'purple',
      fg: 'gray',
    });
    expect(normalizeFlownoteTextStyle({ bg: '#ff0000', fg: 'blue' })).toEqual({
      bg: null,
      fg: 'blue',
    });
    expect(normalizeFlownoteTextStyle({ bg: 'danger', fg: 'on-danger' })).toEqual({
      bg: 'red',
      fg: 'red',
    });
  });
});
