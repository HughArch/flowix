// Block-level note reference (`/笔记卡片`).
//
// Distinct from the inline `noteReference` chip: the block occupies a whole
// line, renders the target note's live preview (cover / title / body snippet),
// and offers FlowUs-style layout switching via a hover toolbar:
//   line      — 默认样式: icon + title + snippet on a single row
//   card      — 小卡片: bordered card, icon + title + 2-line snippet
//   cardLarge — 大卡片: cover banner + icon + title + 3-line snippet
// Markdown form: `::notecard{…json…}` (see note-reference-block-markdown.ts).
import { Node as TiptapNode, mergeAttributes, type JSONContent } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { NodeView as ProseMirrorNodeView, EditorView } from '@tiptap/pm/view';
import { isMobileDevice } from '@shared/platform';

import { translate, type I18nKey } from '@/lib/i18n';
import { getCurrentAppLanguage } from '@features/preferences/public/runtime-api';
import { toast } from '@/lib/toast';
import { openNoteByNotebookPath, openNoteByPhysicalPath } from '@features/memo/public/note-navigation-api';
import { CANVAS_FILE_ICON_SVG, NOTE_FILE_ICON_SVG } from '@features/content/components/content-icon-svg';
import { resolveNoteCoverUrl } from '@features/document/components/note-cover/cover-url';
import {
  NoteReferencePreviewController,
} from '@features/editor/extensions/note-link/note-reference-preview-controller';
import {
  loadNoteReferencePreviewData,
  noteReferenceDisplayTitle,
  refreshNoteReferenceStale,
} from '@features/editor/extensions/note-link/note-preview-data';
import type { NoteReferenceAttrs } from '@features/editor/extensions/note-link/note-reference-markdown';
import {
  NOTE_BLOCK_MARKER,
  normalizeNoteBlockAttrs,
  noteReferenceBlockMarkdownSpec,
  type NoteReferenceBlockLayout,
} from './note-reference-block-markdown';

function tKey(key: I18nKey, params?: Record<string, string | number>): string {
  return translate(getCurrentAppLanguage(), key, params);
}

type BlockAttrs = NoteReferenceAttrs & { layout: NoteReferenceBlockLayout };

/** Locator fields that invalidate cached preview data when they change. */
function locatorKey(attrs: BlockAttrs): string {
  return JSON.stringify([
    attrs.notebookId ?? '',
    attrs.notebookName ?? '',
    attrs.relativePath ?? '',
    attrs.originalPath ?? '',
    attrs.linkTarget ?? '',
  ]);
}

const TOOLBAR_ICONS: Record<'open' | NoteReferenceBlockLayout, string> = {
  open: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>',
  line: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" y1="12" x2="20" y2="12"/></svg>',
  card: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="2"/><line x1="4" y1="10" x2="20" y2="10"/></svg>',
  cardLarge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
};

const LAYOUT_LABEL_KEYS: Record<NoteReferenceBlockLayout, I18nKey> = {
  line: 'editor.noteBlock.layoutLine',
  card: 'editor.noteBlock.layoutCard',
  cardLarge: 'editor.noteBlock.layoutCardLarge',
};

// ─── NodeView ─────────────────────────────────────────────────────────────────

class NoteReferenceBlockView implements ProseMirrorNodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement | null = null;
  private node: ProseMirrorNode;
  private view: EditorView;
  private getPos: (() => number | undefined) | undefined;
  private destroyed = false;
  private previewController: NoteReferencePreviewController;
  /** 全量卡片内容(标题/摘要/封面)按 locator 缓存, 布局切换不重新请求. */
  private dataKey: string | null = null;
  private dataPromise: Promise<void> | null = null;
  private data: Awaited<ReturnType<typeof loadNoteReferencePreviewData>> = null;

  constructor(node: ProseMirrorNode, view: EditorView, getPos: (() => number | undefined) | undefined) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;

    this.dom = document.createElement('div');
    this.dom.className = 'editor-note-reference-block';
    this.dom.contentEditable = 'false';
    this.dom.addEventListener('mousedown', this.handleMouseDown);
    this.dom.addEventListener('dblclick', this.handleDoubleClick);

    this.dom.appendChild(this.createToolbar());

    const card = document.createElement('div');
    card.className = 'note-block__card';
    this.dom.appendChild(card);

    this.previewController = new NoteReferencePreviewController({
      anchor: this.dom,
      mode: 'hover',
      getLocatorKey: () => locatorKey(this.attrs),
      getFallbackTitle: () => noteReferenceDisplayTitle(this.attrs) || tKey('editor.noteLink.untitled'),
      loadData: () => loadNoteReferencePreviewData(this.attrs, tKey('editor.noteLink.untitled')),
      openNote: async () => { await this.openReference(); },
      t: (key) => tKey(key),
      onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
    });

    this.renderCard();
    this.scheduleStaleCheck();
    void this.loadData();
  }

  private get attrs(): BlockAttrs {
    return normalizeNoteBlockAttrs(this.node.attrs as Partial<BlockAttrs>);
  }

  // ── DOM builders ────────────────────────────────────────────────────────

  private createToolbar(): HTMLElement {
    const toolbar = document.createElement('div');
    toolbar.className = 'note-block__toolbar';
    toolbar.contentEditable = 'false';

    const open = this.createToolbarButton('open', tKey('editor.noteLink.openNote'));
    toolbar.appendChild(open);

    const separator = document.createElement('span');
    separator.className = 'note-block__toolbar-separator';
    toolbar.appendChild(separator);

    const layouts: NoteReferenceBlockLayout[] = ['line', 'card', 'cardLarge'];
    for (const layout of layouts) {
      toolbar.appendChild(this.createToolbarButton(layout, tKey(LAYOUT_LABEL_KEYS[layout])));
    }
    return toolbar;
  }

  private createToolbarButton(action: 'open' | NoteReferenceBlockLayout, label: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'note-block__toolbar-button';
    button.dataset.action = action;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.innerHTML = TOOLBAR_ICONS[action];
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.destroyed || !this.view.editable) return;
      if (action === 'open') void this.openReference();
      else this.applyAttrs({ layout: action });
    });
    return button;
  }

  private renderCard(): void {
    const card = this.dom.querySelector('.note-block__card');
    if (!card) return;
    const attrs = this.attrs;
    const isCanvas = typeof attrs.relativePath === 'string' && /\.flowix-canvas$/i.test(attrs.relativePath);
    const iconSvg = isCanvas ? CANVAS_FILE_ICON_SVG : NOTE_FILE_ICON_SVG;
    const title = noteReferenceDisplayTitle(attrs) || this.data?.title || tKey('editor.noteLink.untitled');

    card.innerHTML = '';
    this.dom.dataset.layout = attrs.layout;
    this.dom.classList.toggle('is-stale', attrs.stale);
    this.dom.setAttribute('data-note-block-title', title);

    if (attrs.stale) {
      const staleMark = document.createElement('span');
      staleMark.className = 'note-block__stale-mark';
      staleMark.textContent = tKey('editor.noteLink.staleMark');
      card.appendChild(staleMark);
    }

    // 大卡片: 封面横幅置顶 (无封面时退化为图标占位, 保持卡片体量).
    // 封面可能是附件键 / builtin: 资产 / 远程 URL, 统一经 resolveNoteCoverUrl 解析.
    if (attrs.layout === 'cardLarge') {
      const banner = document.createElement('div');
      banner.className = 'note-block__banner';
      const coverUrl = this.data?.thumbnail
        ? resolveNoteCoverUrl(this.data.thumbnail, this.data.notebookPath)
        : null;
      if (coverUrl) {
        const image = document.createElement('img');
        image.className = 'note-block__banner-image';
        image.alt = '';
        image.draggable = false;
        image.loading = 'lazy';
        image.src = coverUrl;
        banner.appendChild(image);
      } else {
        const placeholder = document.createElement('div');
        placeholder.className = 'note-block__banner-placeholder';
        placeholder.innerHTML = iconSvg;
        banner.appendChild(placeholder);
      }
      card.appendChild(banner);
    }

    const head = document.createElement('div');
    head.className = 'note-block__head';
    const icon = document.createElement('span');
    icon.className = 'note-block__icon';
    icon.innerHTML = iconSvg;
    const titleSpan = document.createElement('span');
    titleSpan.className = 'note-block__title';
    titleSpan.textContent = title;
    titleSpan.title = attrs.originalPath || title;
    head.append(icon, titleSpan);
    card.appendChild(head);

    // 摘要文本: line 布局内联截断; 卡片布局独立区块.
    const previewText = this.data?.preview.trim() ?? '';
    if (previewText || !this.data) {
      const preview = document.createElement('div');
      preview.className = attrs.layout === 'line'
        ? 'note-block__snippet'
        : 'note-block__preview';
      preview.textContent = previewText;
      card.appendChild(preview);
    }

    // 工具条按钮选中态与当前布局同步.
    for (const button of Array.from(this.dom.querySelectorAll<HTMLButtonElement>('.note-block__toolbar-button'))) {
      const action = button.dataset.action;
      button.classList.toggle('is-active', action === attrs.layout);
      button.setAttribute('aria-pressed', String(action === attrs.layout));
    }
  }

  // ── Data ────────────────────────────────────────────────────────────────

  private async loadData(): Promise<void> {
    const attrs = this.attrs;
    const key = locatorKey(attrs);
    if (this.dataKey === key) return;
    const requestId = ++NoteReferenceBlockView.loadSequence;
    const previous = this.dataPromise;
    this.dataKey = key;
    this.dataPromise = (async () => {
      if (previous) await previous.catch(() => { /* 上一轮请求失败不阻塞本轮. */ });
      if (this.destroyed || locatorKey(this.attrs) !== key) return;
      try {
        const data = await loadNoteReferencePreviewData(attrs, tKey('editor.noteLink.untitled'));
        if (this.destroyed || requestId !== NoteReferenceBlockView.loadSequence) return;
        this.data = data;
        this.renderCard();
      } catch { /* 卡片保持 attrs 标题; hover 预览自行兜底. */ }
    })();
    await this.dataPromise;
  }

  private static loadSequence = 0;

  private scheduleStaleCheck(): void {
    const attrs = this.attrs;
    if (!attrs.notebookId && !attrs.originalPath && !attrs.linkTarget) return;
    void refreshNoteReferenceStale(attrs, (patch) => this.applyAttrs(patch, { history: false }));
  }

  // ── Interactions ────────────────────────────────────────────────────────

  private handleMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    const target = event.target;
    if (target instanceof Node && this.dom.querySelector('.note-block__toolbar')?.contains(target)) return;
    // stopEvent 拦截后 PM 不会自行设置选区, 这里手动选中节点;
    // preventDefault 避免 PM 把光标放进块内 (atom 无内容).
    event.preventDefault();
    this.selectOnClick();
  };

  private handleDoubleClick = (): void => {
    void this.openReference();
  };

  private async openReference(): Promise<void> {
    const attrs = this.attrs;
    const destination = isMobileDevice() ? undefined : 'browser-column' as const;
    try {
      if (attrs.notebookId && attrs.relativePath) {
        await openNoteByNotebookPath(attrs.notebookId, attrs.relativePath, attrs.heading, { destination });
      } else if (attrs.originalPath) {
        await openNoteByPhysicalPath(attrs.originalPath, attrs.heading, { destination });
      } else if (attrs.linkTarget) {
        await openNoteByPhysicalPath(attrs.linkTarget, null, { destination });
      } else {
        this.applyAttrs({ stale: true }, { history: false });
        return;
      }
      if (attrs.stale) this.applyAttrs({ stale: false }, { history: false });
    } catch (err) {
      this.applyAttrs({ stale: true }, { history: false });
      // eslint-disable-next-line no-console
      console.warn('[note-reference-block] open failed:', err);
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  private applyAttrs(patch: Partial<BlockAttrs>, options?: { history?: boolean }): void {
    if (this.destroyed || this.view.isDestroyed) return;
    const pos = this.getPos?.();
    if (pos === undefined) return;
    const nodeAtPos = this.view.state.doc.nodeAt(pos);
    if (!nodeAtPos || nodeAtPos.type.name !== 'noteReferenceBlock') return;
    const { selection } = this.view.state;
    const tr = this.view.state.tr.setNodeMarkup(pos, undefined, {
      ...this.node.attrs,
      ...patch,
    });
    tr.setSelection(selection.map(tr.doc, tr.mapping));
    if (options?.history === false) tr.setMeta('addToHistory', false);
    this.view.dispatch(tr);
  }

  private selectOnClick(): void {
    const pos = this.getPos?.();
    if (pos === undefined) return;
    const selection = NodeSelection.create(this.view.state.doc, pos);
    this.view.dispatch(this.view.state.tr.setSelection(selection));
  }

  // ── NodeView protocol ───────────────────────────────────────────────────

  update(node: ProseMirrorNode): boolean {
    if (node.type.name !== 'noteReferenceBlock') return false;
    const previousKey = locatorKey(this.attrs);
    this.node = node;
    this.renderCard();
    if (locatorKey(this.attrs) !== previousKey) {
      this.dataKey = null;
      this.previewController.invalidate();
      void this.loadData();
      this.scheduleStaleCheck();
    }
    return true;
  }

  selectNode(): void {
    this.dom.classList.add('is-selected');
  }

  deselectNode(): void {
    this.dom.classList.remove('is-selected');
  }

  stopEvent(event: Event): boolean {
    // 卡片内部事件不让 ProseMirror 接管; dblclick 用于打开笔记.
    if (event.type.startsWith('composition')) return false;
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.destroyed = true;
    this.dom.removeEventListener('mousedown', this.handleMouseDown);
    this.dom.removeEventListener('dblclick', this.handleDoubleClick);
    this.previewController.dispose();
  }
}

// ─── Node definition ──────────────────────────────────────────────────────────

function blockAttrsFromReferenceAttrs(attrs: NoteReferenceAttrs, layout?: NoteReferenceBlockLayout): BlockAttrs {
  return normalizeNoteBlockAttrs({ ...attrs, layout });
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    noteReferenceBlock: {
      /** 在当前选区插入块级笔记引用 (整行占位). */
      insertNoteReferenceBlock: (attrs: NoteReferenceAttrs, layout?: NoteReferenceBlockLayout) => ReturnType;
    };
  }
}

export const NoteReferenceBlock = TiptapNode.create({
  name: 'noteReferenceBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      relativePath: { default: null },
      notebookId: { default: null },
      notebookName: { default: '' },
      title: { default: '' },
      originalPath: { default: null },
      linkStyle: { default: 'flowix' },
      linkTarget: { default: null },
      heading: { default: null },
      stale: { default: false },
      layout: { default: 'card' },
    };
  },

  parseHTML() {
    return [{
      tag: 'div[data-type="note-reference-block"]',
      getAttrs: (el: HTMLElement) => {
        const attrs = normalizeNoteBlockAttrs({
          notebookId: el.getAttribute('data-notebook-id') || null,
          relativePath: el.getAttribute('data-relative-path') || null,
          notebookName: el.getAttribute('data-notebook-name') || '',
          title: el.getAttribute('data-title') || '',
          originalPath: el.getAttribute('data-original-path') || null,
          linkStyle: 'flowix',
          linkTarget: el.getAttribute('data-link-target') || null,
          heading: null,
          stale: el.getAttribute('data-stale') === 'true',
          layout: (el.getAttribute('data-layout') ?? undefined) as NoteReferenceBlockLayout | undefined,
        });
        return attrs;
      },
    }];
  },

  renderHTML({ node }) {
    const attrs = normalizeNoteBlockAttrs(node.attrs as Partial<BlockAttrs>);
    // The NodeView owns the visible DOM; these data attributes carry the
    // reference into static/read-only output and the clipboard.
    return ['div', mergeAttributes({
      'data-type': 'note-reference-block',
      'data-notebook-id': attrs.notebookId ?? '',
      'data-relative-path': attrs.relativePath ?? '',
      'data-notebook-name': attrs.notebookName,
      'data-title': attrs.title,
      'data-original-path': attrs.originalPath ?? '',
      'data-link-target': attrs.linkTarget ?? '',
      'data-layout': attrs.layout,
      ...(attrs.stale ? { 'data-stale': 'true' } : {}),
      contenteditable: 'false',
      class: 'editor-note-reference-block',
    })];
  },

  addCommands() {
    return {
      insertNoteReferenceBlock: (attrs, layout) => ({ state, dispatch, tr }) => {
        const nodeType = state.schema.nodes.noteReferenceBlock;
        if (!nodeType) return false;
        tr.replaceSelectionWith(nodeType.create(blockAttrsFromReferenceAttrs(attrs, layout)));
        dispatch?.(tr.scrollIntoView());
        return true;
      },
    };
  },

  ...noteReferenceBlockMarkdownSpec,

  renderMarkdown(node: JSONContent) {
    const attrs = normalizeNoteBlockAttrs((node.attrs ?? {}) as Partial<BlockAttrs>);
    return `${NOTE_BLOCK_MARKER}${JSON.stringify(attrs)}`;
  },

  addNodeView() {
    return ({ node, view, getPos }) => new NoteReferenceBlockView(
      node,
      view,
      getPos as (() => number | undefined) | undefined,
    );
  },
});
