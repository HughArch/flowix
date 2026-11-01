import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { notes } from '@platform/tauri/client';
import { useNoteStore, type Notebook } from '@features/memo/store/note-store';
import { createMarkdownEditorExtensions, serializeEditorMarkdown } from '@features/editor/markdown-editor-extensions';
import {
  NOTE_BLOCK_MARKER,
  normalizeNoteBlockAttrs,
} from './note-reference-block-markdown';
import { computeNoteBlockRuns, NoteReferenceBlock } from './note-reference-block';

const notebook: Notebook = {
  id: 'work', name: 'Work', path: '/notes',
  createdAt: 0, updatedAt: 0, isDefault: true,
};

const blockAttrs = {
  notebookId: 'work',
  relativePath: 'Projects/Plan.md',
  notebookName: 'Work',
  title: 'Plan',
  originalPath: null,
  linkStyle: 'flowix',
  linkTarget: null,
  heading: null,
  stale: false,
  layout: 'cardLarge',
  color: '',
  customText: '',
};

const editors: Editor[] = [];
const initialNoteState = useNoteStore.getState();

beforeEach(() => {
  useNoteStore.setState({
    notebooks: [notebook],
    selectedNotebook: notebook,
    selectedNotebookId: notebook.id,
  });
});

afterEach(() => {
  editors.splice(0).forEach(editor => editor.destroy());
  document.body.replaceChildren();
  useNoteStore.setState(initialNoteState);
  vi.restoreAllMocks();
});

function mountBlock(overrides: Record<string, unknown> = {}): Editor {
  const element = document.createElement('div');
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: [StarterKit, NoteReferenceBlock],
    content: {
      type: 'doc',
      content: [
        { type: 'paragraph' },
        { type: 'noteReferenceBlock', attrs: { ...blockAttrs, ...overrides } },
      ],
    },
  });
  editors.push(editor);
  return editor;
}

describe('noteReferenceBlock markdown', () => {
  it('parses ::notecard back into the block node and serializes losslessly', () => {
    vi.spyOn(notes, 'getIndexed').mockResolvedValue(null as never);
    const markdown = `Before\n\n${NOTE_BLOCK_MARKER}${JSON.stringify(blockAttrs)}\n\nAfter`;
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
      content: markdown,
      contentType: 'markdown',
    });
    editors.push(editor);

    const blocks = editor.getJSON().content ?? [];
    const block = blocks.find(node => node.type === 'noteReferenceBlock');
    expect(block?.attrs).toMatchObject({ notebookId: 'work', relativePath: 'Projects/Plan.md', layout: 'cardLarge' });
    expect(serializeEditorMarkdown(editor)).toBe(markdown);
  });

  it('keeps JSON payloads whose strings contain closing braces', () => {
    vi.spyOn(notes, 'getIndexed').mockResolvedValue(null as never);
    const tricky = {
      ...blockAttrs,
      title: 'Plan } not a terminator {',
    };
    const markdown = `Before\n\n${NOTE_BLOCK_MARKER}${JSON.stringify(tricky)}\n\nAfter`;
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
      content: markdown,
      contentType: 'markdown',
    });
    editors.push(editor);
    const block = (editor.getJSON().content ?? []).find(node => node.type === 'noteReferenceBlock');
    expect(block?.attrs).toMatchObject({ title: tricky.title, layout: 'cardLarge' });
    expect(serializeEditorMarkdown(editor)).toBe(markdown);
  });

  it('falls back to defaults for malformed payloads', () => {
    const normalized = normalizeNoteBlockAttrs({ layout: 'bogus' as never, stale: true });
    expect(normalized.layout).toBe('card');
    expect(normalized.stale).toBe(true);
    expect(normalized.linkStyle).toBe('flowix');
  });
});

describe('noteReferenceBlock node view', () => {
  it('renders title and async preview, and switches layout from the hover toolbar', async () => {
    const getIndexed = vi.spyOn(notes, 'getIndexed').mockResolvedValue({
      relativePath: 'Projects/Plan.md', title: 'Plan', preview: 'The body preview', thumbnail: null,
      tags: [], todos: [], agents: [], createdAt: 0, updatedAt: 0,
      favorited: false, icon: null, colors: [], properties: {},
    });

    const editor = mountBlock();
    const wrapper = editor.view.dom.querySelector<HTMLElement>('.editor-note-reference-block')!;
    expect(wrapper).not.toBeNull();
    expect(wrapper.dataset.layout).toBe('cardLarge');
    expect(wrapper.querySelector('.note-block__banner')).not.toBeNull();

    await vi.waitFor(() => {
      expect(wrapper.querySelector('.note-block__preview')?.textContent).toBe('The body preview');
    });

    const lineButton = wrapper.querySelector<HTMLButtonElement>('.note-block__toolbar-button[data-action="line"]')!;
    lineButton.click();
    await vi.waitFor(() => {
      const node = (editor.getJSON().content ?? []).find(item => item.type === 'noteReferenceBlock');
      expect(node?.attrs).toMatchObject({ layout: 'line' });
    });
    expect(wrapper.dataset.layout).toBe('line');
    expect(wrapper.querySelector('.note-block__banner')).toBeNull();
    // 预览数据按 locator 缓存, 布局切换不重新请求 (并发后台校验不算).
    const callsAfterLoad = getIndexed.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(getIndexed.mock.calls.length).toBe(callsAfterLoad);
  });

  it('opens the hover preview popover with the loaded note data', async () => {
    vi.spyOn(notes, 'getIndexed').mockResolvedValue({
      relativePath: 'Projects/Plan.md', title: 'Plan', preview: 'The body preview', thumbnail: null,
      tags: [], todos: [], agents: [], createdAt: 0, updatedAt: 0,
      favorited: false, icon: null, colors: [], properties: {},
    });

    const editor = mountBlock();
    const wrapper = editor.view.dom.querySelector<HTMLElement>('.editor-note-reference-block')!;
    wrapper.dispatchEvent(new window.PointerEvent('pointerenter', { bubbles: false }));

    await vi.waitFor(() => {
      const popover = document.querySelector<HTMLElement>('.note-reference-preview');
      expect(popover?.hidden).toBe(false);
      // 全文渲染不可用时内容区退回纯文本摘要.
      expect(document.querySelector('.note-reference-preview__content')?.textContent).toBe('The body preview');
    }, { timeout: 3000 });

    wrapper.dispatchEvent(new window.PointerEvent('pointerleave', { bubbles: false }));
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>('.note-reference-preview')?.hidden).toBe(true);
    }, { timeout: 3000 });
  });

  it('renders the full note into the scrollable hover preview when readable', async () => {
    vi.spyOn(notes, 'getIndexed').mockResolvedValue({
      relativePath: 'Projects/Plan.md', title: 'Plan', preview: '', thumbnail: null,
      tags: [], todos: [], agents: [], createdAt: 0, updatedAt: 0,
      favorited: false, icon: '📘', colors: [], properties: {},
    });
    vi.spyOn(notes, 'readDocument').mockResolvedValue('# 渲染标题\n\n正文段落。');

    const editor = mountBlock();
    const wrapper = editor.view.dom.querySelector<HTMLElement>('.editor-note-reference-block')!;
    wrapper.dispatchEvent(new window.PointerEvent('pointerenter', { bubbles: false }));

    await vi.waitFor(() => {
      const content = document.querySelector<HTMLElement>('.note-reference-preview__content');
      expect(content?.querySelector('h1')?.textContent).toBe('渲染标题');
      expect(content?.textContent).toContain('正文段落。');
    }, { timeout: 3000 });
    // 卡片摘要取自全文纯文本, 首行特殊块不再一刀切丢内容.
    expect(wrapper.querySelector('.note-block__preview')?.textContent).toContain('渲染标题');
  });

  it('shows the note emoji icon in the card and the preview popover', async () => {
    vi.spyOn(notes, 'getIndexed').mockResolvedValue({
      relativePath: 'Projects/Plan.md', title: 'Plan', preview: 'The body preview', thumbnail: null,
      tags: [], todos: [], agents: [], createdAt: 0, updatedAt: 0,
      favorited: false, icon: '🔥', colors: [], properties: {},
    });

    const editor = mountBlock({ layout: 'cardLarge' });
    const wrapper = editor.view.dom.querySelector<HTMLElement>('.editor-note-reference-block')!;
    await vi.waitFor(() => {
      expect(wrapper.querySelector('.note-block__note-icon')?.textContent).toBe('🔥');
    });

    wrapper.dispatchEvent(new window.PointerEvent('pointerenter', { bubbles: false }));
    await vi.waitFor(() => {
      const popover = document.querySelector<HTMLElement>('.note-reference-preview');
      expect(popover?.hidden).toBe(false);
      expect(document.querySelector('.note-reference-preview__icon')?.textContent).toBe('🔥');
    }, { timeout: 3000 });
  });
});

describe('noteReferenceBlock row layout', () => {
  function mountDoc(content: Array<Record<string, unknown>>): Editor {
    const element = document.createElement('div');
    document.body.append(element);
    const editor = new Editor({
      element,
      extensions: [StarterKit, NoteReferenceBlock],
      content: { type: 'doc', content },
    });
    editors.push(editor);
    return editor;
  }

  it('computes consecutive runs of large cards only', () => {
    vi.spyOn(notes, 'getIndexed').mockResolvedValue(null as never);
    const large = { type: 'noteReferenceBlock', attrs: { ...blockAttrs, layout: 'cardLarge' } };
    const small = { type: 'noteReferenceBlock', attrs: { ...blockAttrs, layout: 'card' } };
    const editor = mountDoc([
      { type: 'paragraph' },
      large,
      large,
      { type: 'paragraph' },
      large,
      small, // 小卡片打断 run 且自身不参与
      large,
    ]);
    const runs = computeNoteBlockRuns(editor.state.doc);
    expect(runs).toEqual([
      { pos: 2, count: 2, index: 0 },
      { pos: 3, count: 2, index: 1 },
      { pos: 6, count: 1, index: 0 },
      { pos: 8, count: 1, index: 0 },
    ]);
  });

  it('writes run data attributes onto large-card DOM only', async () => {
    vi.spyOn(notes, 'getIndexed').mockResolvedValue(null as never);
    const large = { type: 'noteReferenceBlock', attrs: { ...blockAttrs, layout: 'cardLarge' } };
    const small = { type: 'noteReferenceBlock', attrs: { ...blockAttrs, layout: 'card' } };
    const editor = mountDoc([{ type: 'paragraph' }, large, large, small]);
    const wrappers = [...editor.view.dom.querySelectorAll<HTMLElement>('.editor-note-reference-block')];
    expect(wrappers.map((w) => w.dataset.runCount)).toEqual(['2', '2', undefined]);
    expect(wrappers.map((w) => w.dataset.runIndex)).toEqual(['0', '1', undefined]);
    // 大卡片被切换为小卡片后 (布局工具条), run 重新同步:
    // 第一张不再参与, 第二张大卡片自成为单卡 run.
    const toolbar = wrappers[0].querySelector<HTMLButtonElement>('.note-block__toolbar-button[data-action="card"]')!;
    toolbar.click();
    await vi.waitFor(() => {
      const after = [...editor.view.dom.querySelectorAll<HTMLElement>('.editor-note-reference-block')];
      expect(after.map((w) => w.dataset.runCount)).toEqual([undefined, '1', undefined]);
    });
  });

  it('keeps small-card rows full width: stacked cards do not merge into one run', () => {
    vi.spyOn(notes, 'getIndexed').mockResolvedValue(null as never);
    const small = { type: 'noteReferenceBlock', attrs: { ...blockAttrs, layout: 'card' } };
    const editor = mountDoc([{ type: 'paragraph' }, small, small]);
    const runs = computeNoteBlockRuns(editor.state.doc);
    expect(runs).toEqual([]);
    const wrappers = [...editor.view.dom.querySelectorAll<HTMLElement>('.editor-note-reference-block')];
    expect(wrappers.map((w) => w.dataset.runCount)).toEqual([undefined, undefined]);
  });
});

describe('noteReferenceBlock style panel', () => {
  it('configures fill color and custom display text from the toolbar', async () => {
    vi.spyOn(notes, 'getIndexed').mockResolvedValue({
      relativePath: 'Projects/Plan.md', title: 'Plan', preview: 'The body preview', thumbnail: null,
      tags: [], todos: [], agents: [], createdAt: 0, updatedAt: 0,
      favorited: false, icon: null, colors: [], properties: {},
    });

    const editor = mountBlock({ layout: 'card' });
    const wrapper = editor.view.dom.querySelector<HTMLElement>('.editor-note-reference-block')!;

    // 铅笔按钮现在是"卡片样式"入口而非打开笔记.
    const styleButton = wrapper.querySelector<HTMLButtonElement>('.note-block__toolbar-button[data-action="style"]')!;
    expect(styleButton.getAttribute('aria-label')).toBe('卡片样式');
    // 面板挂在 body 下 (脱离编辑器 DOM, 输入不会被 ProseMirror 当作文档突变).
    expect(document.querySelector('.note-block__style-panel')).toBeNull();
    styleButton.click();
    const panel = document.querySelector<HTMLElement>('.note-block__style-panel')!;
    expect(panel).not.toBeNull();

    // 选填充色 → attrs.color 与卡片 data-color 同步.
    const yellow = panel.querySelector<HTMLButtonElement>('.note-block__swatch[data-color="yellow"]')!;
    yellow.click();
    await vi.waitFor(() => {
      const node = (editor.getJSON().content ?? []).find(item => item.type === 'noteReferenceBlock');
      expect(node?.attrs).toMatchObject({ color: 'yellow' });
    });
    expect(wrapper.dataset.color).toBe('yellow');

    // 自定义展示文字 (Enter 提交并关闭面板) → 摘要行替换为自定义文字.
    const input = panel.querySelector<HTMLInputElement>('.note-block__style-input')!;
    input.value = '自定义摘要文字';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await vi.waitFor(() => {
      const node = (editor.getJSON().content ?? []).find(item => item.type === 'noteReferenceBlock');
      expect(node?.attrs).toMatchObject({ customText: '自定义摘要文字' });
    });
    expect(wrapper.querySelector('.note-block__preview')?.textContent).toBe('自定义摘要文字');
    expect(document.querySelector('.note-block__style-panel')).toBeNull();
  });
});
