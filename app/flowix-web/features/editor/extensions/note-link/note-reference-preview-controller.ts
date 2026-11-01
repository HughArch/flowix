import type { I18nKey } from '@/lib/i18n';
import { resolveNoteCoverUrl } from '@features/document/components/note-cover/cover-url';

export interface NoteReferencePreviewData {
  title: string;
  /** 渲染后的纯文本摘要 (卡片摘要行用). */
  preview: string;
  /** 完整笔记渲染出的只读 HTML; 空串表示渲染不可用 (弹窗退回摘要展示). */
  contentHtml: string;
  thumbnail: string | null;
  /** 原笔记的 emoji 图标 (属性面板 icon); 无图标时为 null. */
  icon: string | null;
  notebookId: string;
  relativePath: string;
  notebookPath: string;
  filePath: string;
}

/** `toggle`: click-to-open (agent composer chips). `hover`: pointer-delay popover. */
export type NoteReferencePreviewMode = 'toggle' | 'hover';

interface NoteReferencePreviewControllerOptions {
  anchor: HTMLElement;
  getLocatorKey: () => string;
  getFallbackTitle: () => string;
  loadData: () => Promise<NoteReferencePreviewData | null>;
  openNote: (data: NoteReferencePreviewData) => Promise<void>;
  t: (key: I18nKey) => string;
  onError: (error: unknown) => void;
  mode?: NoteReferencePreviewMode;
  /** Hover open delay in ms (hover mode only). */
  hoverOpenDelay?: number;
  /** Hover close delay in ms (hover mode only); covers the card → popover hop. */
  hoverCloseDelay?: number;
  /** 定位向上翻转时额外让出的顶部高度 (px), 避免盖住卡片悬浮工具条. */
  topClearance?: number;
}

function noteReferenceThumbnailUrl(thumbnail: string | null, notebookPath?: string | null): string | null {
  // Manual covers may be `builtin:` app assets, remote URLs, or attachment
  // keys; resolveNoteCoverUrl handles every persisted form.
  return resolveNoteCoverUrl(thumbnail, notebookPath);
}

const HOVER_OPEN_DELAY_MS = 450;
const HOVER_CLOSE_DELAY_MS = 260;

/**
 * Owns the note-reference preview popover's DOM, async lifecycle, and
 * placement. `toggle` mode (agent composer) opens/closes on click; `hover`
 * mode opens after a pointer delay and closes when the pointer leaves both
 * the anchor and the popover, so users can read or click into the preview.
 */
export class NoteReferencePreviewController {
  private popover: HTMLDivElement | null = null;
  private title: HTMLElement | null = null;
  private icon: HTMLElement | null = null;
  private content: HTMLElement | null = null;
  private image: HTMLImageElement | null = null;
  private openButton: HTMLButtonElement | null = null;
  private isOpen = false;
  private isDisposed = false;
  private requestId = 0;
  private cache: { key: string; promise: Promise<NoteReferencePreviewData | null> } | null = null;
  private hoverTimer: number | null = null;
  private readonly mode: NoteReferencePreviewMode;

  constructor(private readonly options: NoteReferencePreviewControllerOptions) {
    this.mode = options.mode ?? 'toggle';
    if (this.mode === 'hover') {
      options.anchor.addEventListener('pointerenter', this.handleAnchorPointerEnter);
      options.anchor.addEventListener('pointerleave', this.handleAnchorPointerLeave);
    }
  }

  toggle(): void {
    if (this.isDisposed) return;
    if (this.isOpen) this.close();
    else this.show();
  }

  invalidate(): void {
    this.cache = null;
    if (this.isOpen) this.loadAndRender();
  }

  /** Keep the replacement trigger in sync when its inline-atom DOM is rebuilt. */
  syncAnchorState(): void {
    this.options.anchor
      .querySelector<HTMLElement>('[data-inline-atom-card]')
      ?.setAttribute('aria-expanded', String(this.isOpen));
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.clearHoverTimer();
    if (this.mode === 'hover') {
      this.options.anchor.removeEventListener('pointerenter', this.handleAnchorPointerEnter);
      this.options.anchor.removeEventListener('pointerleave', this.handleAnchorPointerLeave);
    }
    this.close();
    this.popover?.remove();
    this.popover = null;
  }

  private clearHoverTimer(): void {
    if (this.hoverTimer !== null) {
      window.clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
  }

  private scheduleHover(open: boolean, delay: number): void {
    this.clearHoverTimer();
    this.hoverTimer = window.setTimeout(() => {
      this.hoverTimer = null;
      if (this.isDisposed) return;
      if (open) {
        if (!this.isOpen) this.show();
      } else {
        this.close();
      }
    }, delay);
  }

  private handleAnchorPointerEnter = (): void => {
    if (this.isDisposed) return;
    this.scheduleHover(true, this.options.hoverOpenDelay ?? HOVER_OPEN_DELAY_MS);
  };

  private handleAnchorPointerLeave = (event: PointerEvent): void => {
    if (this.isDisposed || !this.isOpen) return;
    // Moving onto the popover keeps it open; the popover installs its own
    // leave handler that closes after the same grace delay.
    const next = event.relatedTarget;
    if (next instanceof Node && this.popover?.contains(next)) return;
    this.scheduleHover(false, this.options.hoverCloseDelay ?? HOVER_CLOSE_DELAY_MS);
  };

  private handlePopoverPointerLeave = (event: PointerEvent): void => {
    if (this.isDisposed || !this.isOpen) return;
    const next = event.relatedTarget;
    if (next instanceof Node && this.options.anchor.contains(next)) return;
    this.scheduleHover(false, this.options.hoverCloseDelay ?? HOVER_CLOSE_DELAY_MS);
  };

  private handlePopoverPointerEnter = (): void => {
    if (this.mode === 'hover') this.clearHoverTimer();
  };

  private ensurePopover(): void {
    if (this.popover) return;

    const popover = document.createElement('div');
    popover.className = 'note-reference-preview';
    popover.hidden = true;
    popover.setAttribute('role', 'dialog');
    popover.addEventListener('pointerenter', this.handlePopoverPointerEnter);
    popover.addEventListener('pointerleave', this.handlePopoverPointerLeave);

    const image = document.createElement('img');
    image.className = 'note-reference-preview__image';
    image.alt = '';
    image.draggable = false;
    image.hidden = true;
    image.addEventListener('load', this.position);
    image.addEventListener('error', () => {
      image.hidden = true;
      this.position();
    });

    const body = document.createElement('div');
    body.className = 'note-reference-preview__body';
    const titleRow = document.createElement('div');
    titleRow.className = 'note-reference-preview__title-row';
    const icon = document.createElement('span');
    icon.className = 'note-reference-preview__icon';
    icon.hidden = true;
    const title = document.createElement('div');
    title.className = 'note-reference-preview__title';
    const content = document.createElement('div');
    // 完整笔记只读内容; 内层 DOM 链与编辑器一致, 让编辑器样式直接生效.
    content.className = 'note-reference-preview__content';

    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'note-reference-preview__open';
    openButton.textContent = this.options.t('editor.noteLink.openNote');
    openButton.addEventListener('mousedown', (event) => event.preventDefault());
    openButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.openReferencedNote();
    });

    titleRow.append(icon, title, openButton);
    body.append(titleRow, content);
    popover.append(image, body);
    document.body.append(popover);

    this.popover = popover;
    this.icon = icon;
    this.title = title;
    this.content = content;
    this.image = image;
    this.openButton = openButton;
  }

  private show(): void {
    this.ensurePopover();
    if (!this.popover || this.isDisposed) return;

    this.isOpen = true;
    this.popover.hidden = false;
    this.options.anchor
      .querySelector<HTMLElement>('[data-inline-atom-card]')
      ?.setAttribute('aria-expanded', 'true');
    window.addEventListener('resize', this.position);
    window.addEventListener('scroll', this.position, true);
    document.addEventListener('pointerdown', this.handleOutsidePointer, true);
    document.addEventListener('keydown', this.handleKeyDown, true);
    this.position();
    this.loadAndRender();
  }

  private close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.requestId += 1;
    if (this.popover) this.popover.hidden = true;
    this.options.anchor
      .querySelector<HTMLElement>('[data-inline-atom-card]')
      ?.setAttribute('aria-expanded', 'false');
    window.removeEventListener('resize', this.position);
    window.removeEventListener('scroll', this.position, true);
    document.removeEventListener('pointerdown', this.handleOutsidePointer, true);
    document.removeEventListener('keydown', this.handleKeyDown, true);
  }

  private handleOutsidePointer = (event: PointerEvent): void => {
    const target = event.target;
    if (
      target instanceof Node &&
      (this.options.anchor.contains(target) || this.popover?.contains(target))
    ) return;
    this.close();
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !this.isOpen) return;
    event.preventDefault();
    event.stopPropagation();
    this.close();
  };

  private loadCachedData(): Promise<NoteReferencePreviewData | null> {
    const key = this.options.getLocatorKey();
    if (this.cache?.key === key) return this.cache.promise;

    const promise = this.options.loadData().catch((error: unknown) => {
      if (this.cache?.key === key) this.cache = null;
      throw error;
    });
    this.cache = { key, promise };
    return promise;
  }

  private loadAndRender(): void {
    if (!this.isOpen || !this.content || !this.openButton || !this.popover) return;
    const requestId = ++this.requestId;
    this.title!.textContent = this.options.getFallbackTitle();
    if (this.icon) this.icon.hidden = true;
    this.popover.setAttribute('aria-label', this.title!.textContent ?? '');
    this.content.textContent = this.options.t('editor.noteLink.previewLoading');
    this.content.classList.add('is-placeholder');
    this.openButton.disabled = true;
    if (this.image) this.image.hidden = true;
    this.position();

    void this.loadCachedData().then((data) => {
      if (this.isDisposed || !this.isOpen || requestId !== this.requestId) return;
      if (!data) {
        this.content!.textContent = this.options.t('editor.noteLink.previewUnavailable');
        this.openButton!.disabled = true;
      } else {
        if (this.icon) {
          if (data.icon) {
            this.icon.textContent = data.icon;
            this.icon.hidden = false;
          } else {
            this.icon.hidden = true;
          }
        }
        this.title!.textContent = data.title;
        this.popover!.setAttribute('aria-label', data.title);
        // 完整笔记渲染 HTML (只读管线输出, 非用户原样注入); 渲染不可用时
        // 退回纯文本摘要, 二者都为空才是真正的"暂无预览内容".
        const html = data.contentHtml.trim();
        if (html) {
          this.content!.classList.remove('is-placeholder');
          this.content!.innerHTML = `
            <div class="note-reference-preview__doc">
              <div class="editor-document-body">
                <div class="ProseMirror tiptap" aria-readonly="true">${html}</div>
              </div>
            </div>`;
        } else {
          this.content!.classList.add('is-placeholder');
          this.content!.textContent = data.preview.trim() || this.options.t('editor.noteLink.previewEmpty');
        }
        this.openButton!.disabled = false;
        const thumbnailUrl = noteReferenceThumbnailUrl(data.thumbnail, data.notebookPath);
        if (thumbnailUrl && this.image) {
          this.image.hidden = false;
          if (this.image.src !== thumbnailUrl) this.image.src = thumbnailUrl;
        }
      }
      this.position();
    }).catch(() => {
      if (this.isDisposed || !this.isOpen || requestId !== this.requestId) return;
      this.content!.textContent = this.options.t('editor.noteLink.previewUnavailable');
      this.openButton!.disabled = true;
      this.position();
    });
  }

  private position = (): void => {
    if (!this.isOpen || !this.popover?.isConnected || !this.options.anchor.isConnected) return;
    const anchorRect = this.options.anchor.getBoundingClientRect();
    const popoverRect = this.popover.getBoundingClientRect();
    const width = popoverRect.width || 304;
    const height = popoverRect.height || 156;
    const padding = 8;
    const clearance = this.options.topClearance ?? 0;
    const left = Math.min(
      Math.max(anchorRect.left + (anchorRect.width - width) / 2, padding),
      Math.max(padding, window.innerWidth - width - padding),
    );
    // 优先放卡片下方 (不挡工具条); 下方放不下再向上翻, 并让出顶部工具条高度.
    const belowTop = anchorRect.bottom + 8;
    let top: number;
    if (belowTop + height <= window.innerHeight - padding) {
      top = belowTop;
    } else {
      const aboveTop = anchorRect.top - height - 8 - clearance;
      top = aboveTop >= padding
        ? aboveTop
        : Math.min(anchorRect.bottom + 8, Math.max(padding, window.innerHeight - height - padding));
    }
    this.popover.style.left = `${left}px`;
    this.popover.style.top = `${top}px`;
  };

  private async openReferencedNote(): Promise<void> {
    const button = this.openButton;
    if (!button || button.disabled || this.isDisposed) return;
    const locatorKey = this.options.getLocatorKey();
    button.disabled = true;
    try {
      const data = await this.loadCachedData();
      // The inline atom may have been edited while the preview request was in
      // flight. Never navigate using data for the previous target.
      if (locatorKey !== this.options.getLocatorKey()) return;
      if (!data) throw new Error(this.options.t('editor.noteLink.previewUnavailable'));
      await this.options.openNote(data);
      this.close();
    } catch (error) {
      this.options.onError(error);
    } finally {
      if (
        !this.isDisposed
        && button.isConnected
        && locatorKey === this.options.getLocatorKey()
      ) button.disabled = false;
    }
  }
}
