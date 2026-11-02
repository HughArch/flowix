import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, it } from 'vitest';

import { Tag } from './tag';

describe('tag decorations', () => {
  it('renders hyphenated and underscored tag paths as complete tags', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, Tag],
      content: '<p>#Long-Term-Task #project_one/phase-2</p>',
    });

    expect([...host.querySelectorAll('.tag-node-prefix')].map((node) => (
      `${node.textContent}${node.parentElement?.nextElementSibling?.textContent ?? ''}`
    ))).toEqual([
      '#Long-Term-Task',
      '#project_one/phase-2',
    ]);

    editor.destroy();
    host.remove();
  });

  it('does not render punctuation-only segments as tags', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, Tag],
      content: '<p>#--- #project/___</p>',
    });

    expect(host.querySelectorAll('.tag-node')).toHaveLength(0);

    editor.destroy();
    host.remove();
  });

  it('splits each editable tag into live prefix and content fragments', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, Tag],
      content: '<p>#first #second</p>',
    });

    const prefixes = [...host.querySelectorAll('.tag-node-prefix')];
    expect(prefixes.map((node) => node.textContent)).toEqual(['#', '#']);
    expect(prefixes.every((node) => (
      node.parentElement?.classList.contains('tag-node-prefix-box') &&
      node.parentElement.nextElementSibling?.classList.contains('tag-node-content-box') &&
      node.parentElement.nextElementSibling.firstElementChild?.classList.contains('tag-node-content') &&
      !node.closest('[contenteditable="false"]')
    ))).toBe(true);

    editor.destroy();
    host.remove();
  });

  it('keeps the wrapped prefix and content editable without changing the document structure', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, Tag],
      content: '<p>#first</p>',
    });

    editor.commands.setTextSelection(2);
    editor.commands.insertContent('中文');
    expect(editor.getText()).toBe('#中文first');
    expect(host.querySelector('.tag-node-content')?.textContent).toBe('中文first');
    expect(editor.getJSON().content?.[0].content).toEqual([{ type: 'text', text: '#中文first' }]);

    editor.commands.setTextSelection({ from: 1, to: 2 });
    editor.commands.deleteSelection();
    expect(editor.getText()).toBe('中文first');
    expect(host.querySelectorAll('.tag-node')).toHaveLength(0);

    editor.destroy();
    host.remove();
  });
});
