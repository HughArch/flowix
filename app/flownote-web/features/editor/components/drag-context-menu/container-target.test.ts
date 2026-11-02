import { Editor, type JSONContent } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createMarkdownEditorExtensions } from '@features/editor/markdown-editor-extensions';
import { getBlockInfoAtCoords } from './block-info';
import { resolveContainerBlock } from './positioning';

const editors: Editor[] = [];
const originalElementFromPoint = document.elementFromPoint;

function createEditor(content: JSONContent): Editor {
  const element = document.createElement('div');
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: createMarkdownEditorExtensions({
      getOwnerPath: () => undefined,
      getAttachmentNotebookId: () => undefined,
      workspaceHost: 'main-third',
      getPlaceholder: () => '',
      getHeadingFoldLabels: () => ({ fold: '', unfold: '' }),
    }),
    content,
    contentType: 'json',
  });
  editors.push(editor);
  return editor;
}

function pointAt(element: Element | null): void {
  document.elementFromPoint = () => element as Element | null;
}

afterEach(() => {
  document.elementFromPoint = originalElementFromPoint;
  editors.splice(0).forEach((editor) => editor.destroy());
  document.body.innerHTML = '';
});

function callout(text: string): JSONContent {
  return {
    type: 'callout',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

describe('parent container handle targets', () => {
  it('resolves the callout inside a column, not the whole columns row', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{
        type: 'columns',
        content: [
          { type: 'column', attrs: { width: 100 }, content: [callout('左列提示')] },
          { type: 'column', attrs: { width: 100 }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '右列' }] }] },
        ],
      }],
    });

    const leftColumn = editor.view.dom.querySelectorAll('.flownote-column')[0];
    pointAt(leftColumn.querySelector('.flownote-callout-icon'));
    const info = getBlockInfoAtCoords(editor, 0, 0);
    expect(info?.typeName).toBe('callout');

    const container = resolveContainerBlock(editor, info);

    // 关键回归: 曾经解析到最外层 `columns`, 点击抓手会选中/修改整行。
    expect(container?.typeName).toBe('callout');
    expect(container?.pos).toBe(info?.pos);
    expect(container?.dom.closest('.flownote-column')).toBe(leftColumn);
  });

  it('still resolves a doc-level callout to itself', () => {
    const editor = createEditor({
      type: 'doc',
      content: [callout('顶层提示'), { type: 'paragraph', content: [{ type: 'text', text: '正文' }] }],
    });
    pointAt(editor.view.dom.querySelector('.flownote-callout-icon'));

    const info = getBlockInfoAtCoords(editor, 0, 0);
    const container = resolveContainerBlock(editor, info);

    expect(container?.typeName).toBe('callout');
    expect(container?.pos).toBe(0);
  });

  it('prefers the outer container over a nested list', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{
        type: 'callout',
        content: [{
          type: 'bulletList',
          content: [{
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '条目' }] }],
          }],
        }],
      }],
    });

    pointAt(editor.view.dom.querySelector('li p'));
    const info = getBlockInfoAtCoords(editor, 0, 0);
    expect(info?.typeName).toBe('listItem');

    const container = resolveContainerBlock(editor, info);

    // 列表抓手与 callout 抓手不能同时出现: 取最外层的 callout。
    expect(container?.typeName).toBe('callout');
  });

  it('returns null for a plain top-level paragraph', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '普通段落' }] }],
    });

    pointAt(editor.view.dom.querySelector('p'));
    const info = getBlockInfoAtCoords(editor, 0, 0);

    expect(resolveContainerBlock(editor, info)).toBeNull();
  });
});
