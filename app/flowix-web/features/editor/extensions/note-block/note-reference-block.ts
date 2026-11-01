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
import { Plugin } from '@tiptap/pm/state';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { NodeView as ProseMirrorNodeView, EditorView } from '@tiptap/pm/view';
import { isMobileDevice } from '@shared/platform';
import { NOTE_COLORS } from '@/types/note-item';
import { NOTE_COLOR_HEX } from '@features/memo/store/note-store';

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

type BlockAttrs = NoteReferenceAttrs & {
  layout: NoteReferenceBlockLayout;
  /** 卡片填充色 (NoteColor 小写串; 空串 = 不填充). */
  color: string;
  /** 自定义展示文字: 覆盖卡片摘要 (笔记首行); 空串 = 使用首行. */
  customText: string;
};

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

const TOOLBAR_ICONS: Record<'style' | NoteReferenceBlockLayout, string> = {
  style: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>',
  line: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" y1="12" x2="20" y2="12"/></svg>',
  card: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="2"/><line x1="4" y1="10" x2="20" y2="10"/></svg>',
  cardLarge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
};

const LAYOUT_LABEL_KEYS: Record<NoteReferenceBlockLayout, I18nKey> = {
  line: 'editor.noteBlock.layoutLine',
  card: 'editor.noteBlock.layoutCard',
  cardLarge: 'editor.noteBlock.layoutCardLarge',
};

// ─── 同行多卡片布局 ────────────────────────────────────────────────────────────
// 只有连续相邻的顶层「大卡片」(layout === 'cardLarge') 排成一行: 单卡占 1/3 宽
// (加高趋近方形), 两卡平分一行, 三卡及以上按 1/3 逐行排布。默认样式 / 小卡片
// 保持整行 (block) 行为。run 信息写到卡片 DOM 的 data 属性上 (CSS 按
// data-run-count 选宽度), 不引入包装容器节点, 文档结构保持扁平。
// 卡片放进多列等容器时由 CSS 兜底为 100% 列宽填充, 与现有多列布局复用。

export interface NoteBlockRunInfo {
  /** 节点在 doc 中的起始位置. */
  pos: number;
  /** 所在连续 run 的卡片总数 (封顶 3, 仅用于宽度选择). */
  count: number;
  /** 在 run 内的序号 (0 基). */
  index: number;
}

/** 纯函数: 计算顶层连续大卡片的 run 信息 (供测试与同步共用). */
export function computeNoteBlockRuns(doc: ProseMirrorNode): NoteBlockRunInfo[] {
  const runs: NoteBlockRunInfo[] = [];
  let positions: number[] = [];
  let pos = 0;
  const flush = () => {
    if (positions.length === 0) return;
    const count = Math.min(positions.length, 3);
    positions.forEach((runPos, index) => runs.push({ pos: runPos, count, index }));
    positions = [];
  };
  doc.forEach((node) => {
    const start = pos;
    pos += node.nodeSize;
    // 非大卡片 (默认样式 / 小卡片) 不参与同行排布, 并打断 run.
    if (node.type.name !== 'noteReferenceBlock' || normalizeNoteBlockAttrs(node.attrs as Partial<BlockAttrs>).layout !== 'cardLarge') {
      flush();
      return;
    }
    positions.push(start);
  });
  flush();
  return runs;
}

/** 把 run 信息同步到卡片 NodeView 的外层 DOM (幂等, 只在值变化时写). */
export function syncNoteBlockRunAttributes(view: EditorView): void {
  const runByPos = new Map(computeNoteBlockRuns(view.state.doc).map((run) => [run.pos, run]));
  let pos = 0;
  view.state.doc.forEach((node) => {
    const start = pos;
    pos += node.nodeSize;
    if (node.type.name !== 'noteReferenceBlock') return;
    const dom = view.nodeDOM(start);
    if (!(dom instanceof HTMLElement)) return;
    const run = runByPos.get(start);
    const count = run ? String(run.count) : '';
    const index = run ? String(run.index) : '';
    if (dom.dataset.runCount !== count) {
      if (count) dom.dataset.runCount = count;
      else delete dom.dataset.runCount;
    }
    if (dom.dataset.runIndex !== index) {
      if (index) dom.dataset.runIndex = index;
      else delete dom.dataset.runIndex;
    }
  });
}

function noteBlockRowLayoutPlugin(): Plugin {
  return new Plugin({
    view(editorView) {
      const sync = () => syncNoteBlockRunAttributes(editorView);
      sync();
      return { update: sync, destroy: () => {} };
    },
  });
}

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
    // 悬浮工具条挂 body: .markdown-editor 带 isolation: isolate, 编辑器内部
    // 是独立层叠上下文, 工具条 z-index 再高也压不过挂 body 的预览弹窗;
    // 挂 body 后与弹窗同层比较 (工具条 z 1001 > 弹窗 1000), 始终在最上面.
    this.dom.addEventListener('pointerenter', this.handleCardPointerEnter);
    this.dom.addEventListener('pointerleave', this.handleCardPointerLeave);

    const card = document.createElement('div');
    card.className = 'note-block__card';
    this.dom.appendChild(card);

    document.body.appendChild(this.createToolbar());
    window.addEventListener('resize', this.handleToolbarReposition);
    window.addEventListener('scroll', this.handleToolbarReposition, true);

    this.previewController = new NoteReferencePreviewController({
      anchor: this.dom,
      mode: 'hover',
      // 弹窗向上翻转时让出工具条高度, 避免盖住卡片右上角的布局工具条.
      topClearance: 36,
      // 弹窗关闭后按真实指针位置重算工具条显隐 (弹窗盖卡片期间 cardHovered
      // 被强制保持, 关闭时若指针已不在卡片上需恢复隐藏).
      onClosed: () => {
        if (this.destroyed) return;
        this.cardHovered = this.dom.matches(':hover');
        this.toolbarHovered = this.toolbar?.matches(':hover') ?? false;
        this.syncToolbarVisible();
      },
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

  // ── 悬浮工具条 (挂 body, 跟随卡片右上角) ────────────────────────────────

  private toolbar: HTMLElement | null = null;
  private toolbarHovered = false;
  private cardHovered = false;

  private createToolbar(): HTMLElement {
    const toolbar = document.createElement('div');
    toolbar.className = 'note-block__toolbar';
    toolbar.contentEditable = 'false';
    this.toolbar = toolbar;
    this.syncToolbarVisible();
    toolbar.addEventListener('pointerenter', () => {
      this.toolbarHovered = true;
      this.syncToolbarVisible();
    });
    toolbar.addEventListener('pointerleave', (event) => {
      const next = event.relatedTarget;
      if (next instanceof Node && this.dom.contains(next)) {
        this.cardHovered = true;
      } else {
        this.toolbarHovered = false;
        this.cardHovered = false;
      }
      this.syncToolbarVisible();
    });

    const style = this.createToolbarButton('style', tKey('editor.noteBlock.styleButton'));
    toolbar.appendChild(style);

    const separator = document.createElement('span');
    separator.className = 'note-block__toolbar-separator';
    toolbar.appendChild(separator);

    const layouts: NoteReferenceBlockLayout[] = ['line', 'card', 'cardLarge'];
    for (const layout of layouts) {
      toolbar.appendChild(this.createToolbarButton(layout, tKey(LAYOUT_LABEL_KEYS[layout])));
    }
    return toolbar;
  }

  private handleCardPointerEnter = (): void => {
    this.cardHovered = true;
    this.syncToolbarVisible();
  };

  private handleCardPointerLeave = (event: PointerEvent): void => {
    const next = event.relatedTarget;
    if (next instanceof Node && this.toolbar?.contains(next)) {
      this.toolbarHovered = true;
      this.cardHovered = false;
    } else if (next instanceof Element && next.closest('.note-reference-preview')) {
      // 弹窗向上翻转盖住卡片时, 指针"落在"预览弹窗上 — 视为仍在卡片上,
      // 工具条保持显示 (工具条挂 body 且 z 更高, 始终浮在弹窗之上可点).
      this.cardHovered = true;
    } else {
      this.cardHovered = false;
    }
    this.syncToolbarVisible();
  };

  /** 工具条显隐: hover 卡片或工具条、样式面板打开时显示; 只读态不显示. */
  private syncToolbarVisible(): void {
    const toolbar = this.toolbar;
    if (!toolbar) return;
    const shouldShow = (this.cardHovered || this.toolbarHovered)
      && this.view.editable
      && !this.destroyed;
    toolbar.classList.toggle('is-visible', shouldShow);
    if (shouldShow) this.positionToolbar();
  }

  /** 工具条贴卡片右上角 (原 top -0.8rem), 视口内钳制. */
  private positionToolbar(): void {
    const toolbar = this.toolbar;
    if (!toolbar || this.destroyed) return;
    if (!toolbar.isConnected || !this.dom.isConnected) return;
    const cardRect = this.dom.getBoundingClientRect();
    const toolbarRect = toolbar.getBoundingClientRect();
    const margin = 8;
    const left = Math.min(
      Math.max(margin, cardRect.right - toolbarRect.width - 8),
      Math.max(margin, window.innerWidth - toolbarRect.width - margin),
    );
    // 默认悬在卡片上缘 (-0.8rem); 卡片贴近视口顶部时改放卡片内部顶行.
    let top = cardRect.top - 0.8 * 16;
    if (top < margin) top = cardRect.top + 8;
    toolbar.style.left = `${Math.round(left)}px`;
    toolbar.style.top = `${Math.round(top)}px`;
  }

  private handleToolbarReposition = (): void => {
    this.positionToolbar();
  };

  private createToolbarButton(action: 'style' | NoteReferenceBlockLayout, label: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'note-block__toolbar-button';
    button.dataset.action = action;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-haspopup', 'dialog');
    button.innerHTML = TOOLBAR_ICONS[action];
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.destroyed || !this.view.editable) return;
      if (action === 'style') this.toggleStylePanel();
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
    const noteIcon = this.data?.icon || null;
    const title = noteReferenceDisplayTitle(attrs) || this.data?.title || tKey('editor.noteLink.untitled');

    card.innerHTML = '';
    this.dom.dataset.layout = attrs.layout;
    // 卡片填充色 (样式面板设置; 封面区域不受影响).
    if (attrs.color) this.dom.dataset.color = attrs.color;
    else delete this.dom.dataset.color;
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
        // 封面资源加载失败 (附件暂缺 / 索引抖动) 时退回图标占位, 避免裂图.
        image.addEventListener('error', () => {
          image.remove();
          if (!banner.querySelector('.note-block__banner-placeholder')) {
            const placeholder = document.createElement('div');
            placeholder.className = 'note-block__banner-placeholder';
            if (noteIcon) {
              const iconEmoji = document.createElement('span');
              iconEmoji.className = 'note-block__banner-note-icon';
              iconEmoji.textContent = noteIcon;
              placeholder.appendChild(iconEmoji);
            } else {
              placeholder.innerHTML = iconSvg;
            }
            banner.appendChild(placeholder);
          }
        });
        banner.appendChild(image);
      } else {
        const placeholder = document.createElement('div');
        placeholder.className = 'note-block__banner-placeholder';
        // 原笔记的 emoji 图标优先; 没有图标才用通用文件图形.
        if (noteIcon) {
          const iconEmoji = document.createElement('span');
          iconEmoji.className = 'note-block__banner-note-icon';
          iconEmoji.textContent = noteIcon;
          placeholder.appendChild(iconEmoji);
        } else {
          placeholder.innerHTML = iconSvg;
        }
        banner.appendChild(placeholder);
      }
      card.appendChild(banner);
    }

    const head = document.createElement('div');
    head.className = 'note-block__head';
    const icon = document.createElement('span');
    icon.className = 'note-block__icon';
    // 原笔记的 emoji 图标优先展示; 无图标 / 画布引用退回通用文件图形.
    if (noteIcon && !isCanvas) {
      const iconEmoji = document.createElement('span');
      iconEmoji.className = 'note-block__note-icon';
      iconEmoji.textContent = noteIcon;
      icon.appendChild(iconEmoji);
    } else {
      icon.innerHTML = iconSvg;
    }
    const titleSpan = document.createElement('span');
    titleSpan.className = 'note-block__title';
    titleSpan.textContent = title;
    titleSpan.title = attrs.originalPath || title;
    head.append(icon, titleSpan);
    card.appendChild(head);

    // 摘要文本: 自定义展示文字优先, 否则用笔记正文首行 (全文纯文本);
    // line 布局内联截断, 卡片布局独立区块.
    const customText = attrs.customText.trim();
    const previewText = customText || this.data?.preview.trim() || '';
    if (previewText || !this.data) {
      const preview = document.createElement('div');
      preview.className = attrs.layout === 'line'
        ? 'note-block__snippet'
        : 'note-block__preview';
      preview.textContent = previewText;
      if (customText) preview.title = customText;
      card.appendChild(preview);
    }

    // 工具条 (挂 body) 按钮选中态与当前布局同步.
    for (const button of Array.from(this.toolbar?.querySelectorAll<HTMLButtonElement>('.note-block__toolbar-button') ?? [])) {
      const action = button.dataset.action;
      button.classList.toggle('is-active', action === attrs.layout);
      button.setAttribute('aria-pressed', String(action === attrs.layout));
    }
  }

  // ── DOM builders ────────────────────────────────────────────────────────

  // ── 卡片样式面板 (工具条铅笔按钮) ───────────────────────────────────────

  private stylePanel: HTMLElement | null = null;
  private handleStylePanelOutside: ((event: PointerEvent) => void) | null = null;

  private toggleStylePanel(): void {
    if (this.stylePanel) {
      this.closeStylePanel();
      return;
    }
    // 面板打开期间工具条保持可见 (否则鼠标移向面板时工具条隐藏, 入口消失).
    this.toolbarHovered = true;
    this.syncToolbarVisible();
    const attrs = this.attrs;

    const panel = document.createElement('div');
    panel.className = 'note-block__style-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', tKey('editor.noteBlock.styleButton'));

    // 填充颜色: 封面区域之外的整体背景, 复用笔记颜色体系.
    const colorRow = document.createElement('div');
    colorRow.className = 'note-block__style-row';
    const colorLabel = document.createElement('span');
    colorLabel.className = 'note-block__style-label';
    colorLabel.textContent = tKey('editor.noteBlock.styleColor');
    const swatches = document.createElement('div');
    swatches.className = 'note-block__swatches';
    for (const color of NOTE_COLORS) {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'note-block__swatch';
      swatch.dataset.color = color;
      swatch.title = tKey(`document.color.${color}` as I18nKey);
      swatch.setAttribute('aria-label', swatch.title);
      swatch.style.background = `color-mix(in oklch, ${NOTE_COLOR_HEX[color]} 60%, white)`;
      if (attrs.color === color) swatch.classList.add('is-active');
      swatch.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (this.destroyed) return;
        const next = this.attrs.color === color ? '' : color;
        this.applyAttrs({ color: next });
        for (const item of Array.from(swatches.querySelectorAll('.note-block__swatch'))) {
          item.classList.toggle('is-active', item === swatch && next !== '');
        }
      });
      swatches.appendChild(swatch);
    }
    colorRow.append(colorLabel, swatches);
    panel.appendChild(colorRow);

    // 自定义展示文字: 覆盖卡片摘要 (笔记首行); 留空恢复.
    const textRow = document.createElement('div');
    textRow.className = 'note-block__style-row';
    const textLabel = document.createElement('span');
    textLabel.className = 'note-block__style-label';
    textLabel.textContent = tKey('editor.noteBlock.styleText');
    const textInput = document.createElement('input');
    textInput.className = 'note-block__style-input';
    textInput.type = 'text';
    textInput.placeholder = tKey('editor.noteBlock.styleTextPlaceholder');
    textInput.value = attrs.customText;
    textInput.maxLength = 200;
    const commitText = () => {
      if (this.destroyed) return;
      const value = textInput.value.trim();
      if (value !== this.attrs.customText) this.applyAttrs({ customText: value });
    };
    textInput.addEventListener('keydown', (event) => {
      // 面板内输入不让事件落到编辑器 (stopEvent 已拦, 这里防默认行为).
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        commitText();
        this.closeStylePanel();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        textInput.value = this.attrs.customText;
        this.closeStylePanel();
      }
    });
    textInput.addEventListener('blur', commitText);
    textRow.append(textLabel, textInput);
    panel.appendChild(textRow);

    this.stylePanel = panel;
    // 面板必须挂在 body 下: 挂在卡片 wrapper (编辑器 DOM) 内时, 输入框的
    // 打字/输入法事件会被 ProseMirror 当作文档突变处理, 直接破坏节点.
    document.body.appendChild(panel);
    this.positionStylePanel();
    window.addEventListener('resize', this.handleStylePanelReposition);
    window.addEventListener('scroll', this.handleStylePanelReposition, true);

    // 点击面板外关闭; 面板与工具条内部点击不关 (便于选色/输入).
    this.handleStylePanelOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && this.stylePanel?.contains(target)) return;
      if (target instanceof Node && this.dom.contains(target)) return;
      commitText();
      this.closeStylePanel();
    };
    document.addEventListener('pointerdown', this.handleStylePanelOutside, true);
    window.requestAnimationFrame(() => textInput.focus());
  }

  /** 面板跟随卡片右上角 (工具条下方), 视口内钳制. */
  private positionStylePanel(): void {
    if (!this.stylePanel || this.destroyed) return;
    if (!this.stylePanel.isConnected || !this.dom.isConnected) return;
    const cardRect = this.dom.getBoundingClientRect();
    const panelRect = this.stylePanel.getBoundingClientRect();
    const margin = 8;
    const preferredLeft = cardRect.right - panelRect.width;
    const left = Math.min(
      Math.max(margin, preferredLeft),
      Math.max(margin, window.innerWidth - panelRect.width - margin),
    );
    // 默认贴卡片顶部 (工具条下方); 底部放不下时翻到卡片上方.
    let top = cardRect.top + 2.2 * 16;
    if (top + panelRect.height > window.innerHeight - margin) {
      top = Math.max(margin, cardRect.top - panelRect.height - 8);
    }
    this.stylePanel.style.left = `${Math.round(left)}px`;
    this.stylePanel.style.top = `${Math.round(top)}px`;
  }

  private handleStylePanelReposition = (): void => {
    this.positionStylePanel();
  };

  private closeStylePanel(): void {
    window.removeEventListener('resize', this.handleStylePanelReposition);
    window.removeEventListener('scroll', this.handleStylePanelReposition, true);
    if (this.handleStylePanelOutside) {
      document.removeEventListener('pointerdown', this.handleStylePanelOutside, true);
      this.handleStylePanelOutside = null;
    }
    this.stylePanel?.remove();
    this.stylePanel = null;
    this.toolbarHovered = this.toolbar?.matches(':hover') ?? false;
    this.syncToolbarVisible();
  }

  // ── Data ────────────────────────────────────────────────────────────────

  /** 实例级请求序号: 只作废本节点的过期响应; 类级序号会让并发加载的
   * 其他卡片把先返回的响应误判为过期 (表现为偶发丢封面/摘要). */
  private loadSeq = 0;

  private async loadData(): Promise<void> {
    const attrs = this.attrs;
    const key = locatorKey(attrs);
    if (this.dataKey === key) return;
    const requestId = ++this.loadSeq;
    const previous = this.dataPromise;
    this.dataKey = key;
    this.dataPromise = (async () => {
      if (previous) await previous.catch(() => { /* 上一轮请求失败不阻塞本轮. */ });
      if (this.destroyed || locatorKey(this.attrs) !== key) return;
      try {
        const data = await loadNoteReferencePreviewData(attrs, tKey('editor.noteLink.untitled'));
        if (this.destroyed || requestId !== this.loadSeq) return;
        this.data = data;
        this.renderCard();
      } catch { /* 卡片保持 attrs 标题; hover 预览自行兜底. */ }
    })();
    await this.dataPromise;
  }

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
    this.dom.removeEventListener('pointerenter', this.handleCardPointerEnter);
    this.dom.removeEventListener('pointerleave', this.handleCardPointerLeave);
    window.removeEventListener('resize', this.handleToolbarReposition);
    window.removeEventListener('scroll', this.handleToolbarReposition, true);
    this.closeStylePanel();
    this.toolbar?.remove();
    this.toolbar = null;
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
      color: { default: '' },
      customText: { default: '' },
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
          color: el.getAttribute('data-color') || '',
          customText: el.getAttribute('data-custom-text') || '',
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
      ...(attrs.color ? { 'data-color': attrs.color } : {}),
      ...(attrs.customText ? { 'data-custom-text': attrs.customText } : {}),
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

  addProseMirrorPlugins() {
    return [noteBlockRowLayoutPlugin()];
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
