import { translate, type AppLanguage } from '@/lib/i18n';
import { CALLOUT_ICONS } from './callout-markdown';
import {
  CALLOUT_EMOJI_SEARCH_LIMIT,
  indexCalloutEmojis,
  searchCalloutEmojis,
} from './callout-emoji';
import type { CalloutEmojiEntry, CalloutEmojiGroup } from './emoji-catalog';
import { FLAG_ASSET_URLS } from './flag-assets';

// The full catalog is ~220 KB, so it is split into its own chunk and only
// fetched the first time a picker opens. The "common" grid renders from the
// static list immediately, so the picker never waits on the chunk.
type EmojiCatalogModule = typeof import('./emoji-catalog');
let emojiCatalogPromise: Promise<EmojiCatalogModule> | null = null;

/** Warm the lazy catalog chunk so the first picker open has data ready. */
export function loadEmojiCatalog(): Promise<EmojiCatalogModule> {
  emojiCatalogPromise ??= import('./emoji-catalog');
  return emojiCatalogPromise;
}

/** Zero-width joiner: marks emoji sequences that may render as multiple glyphs. */
const ZWJ = String.fromCharCode(0x200d);

// Virtual grid geometry. `EMOJI_VIEWPORT_HEIGHT` mirrors the CSS max-height of
// `.flowix-emoji-picker__scroll`; the grid only renders the rows around the
// viewport so switching categories never builds hundreds of buttons.
const EMOJI_CELL_SIZE = 28;
const EMOJI_GAP = 2;
const EMOJI_STRIDE = EMOJI_CELL_SIZE + EMOJI_GAP;
const EMOJI_OVERSCAN_ROWS = 1;
const EMOJI_VIEWPORT_HEIGHT = 190;
const EMOJI_GRID_FALLBACK_WIDTH = 300;

export interface EmojiPickerPanelOptions {
  /** Locale used for group tabs and emoji titles. */
  language: AppLanguage;
  /** Receives the chosen Unicode emoji. Runs before `requestClose`. */
  onPick: (unicode: string) => void;
  /** Host-owned dismissal, called after a pick. */
  requestClose: () => void;
  /** Extra controls rendered above the search field. */
  renderHeader?: (requestClose: () => void) => Node[];
  /** Extra controls rendered below the emoji grid. */
  renderFooter?: (requestClose: () => void) => Node[];
  /** Render inline inside an existing popover instead of as a fixed popup. */
  inline?: boolean;
}

export interface EmojiPickerPanel {
  /** Panel root, `position: fixed`; the host appends and positions it. */
  element: HTMLDivElement;
  /** Settles once the full catalog is available (or failed to load). */
  ready: Promise<void>;
  /** Move keyboard focus into the search field. */
  focusSearch: () => void;
  /** Re-measure the grid after the host appends the panel to the DOM. */
  refreshLayout: () => void;
  destroy: () => void;
}

interface ViewItem {
  u: string;
  title: string;
  /** Lowercase hexcode when the emoji has bundled flag artwork. */
  flag?: string;
}

/**
 * Build the shared emoji panel used by the callout icon menu and the slash
 * command. It owns the catalog, search, category tabs and the virtualised
 * grid; positioning and dismissal stay with the host.
 */
export function createEmojiPickerPanel(
  options: EmojiPickerPanelOptions,
): EmojiPickerPanel {
  const { language, onPick, requestClose, renderHeader, renderFooter } = options;

  const element = document.createElement('div');
  element.className = options.inline
    ? 'flowix-emoji-picker flowix-emoji-picker--inline'
    : 'flowix-emoji-picker';
  element.setAttribute('role', 'dialog');
  element.setAttribute('aria-label', translate(language, 'editor.emoji.pickerLabel'));

  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.className = 'flowix-emoji-picker__search';
  searchInput.placeholder = translate(language, 'editor.emoji.loading');
  searchInput.disabled = true;
  searchInput.setAttribute('aria-label', translate(language, 'editor.emoji.search'));

  const tabs = document.createElement('div');
  tabs.className = 'flowix-emoji-picker__tabs';

  const scroll = document.createElement('div');
  scroll.className = 'flowix-emoji-picker__scroll';

  const grid = document.createElement('div');
  grid.className = 'flowix-emoji-picker__grid';

  const windowEl = document.createElement('div');
  windowEl.className = 'flowix-emoji-picker__window';
  grid.appendChild(windowEl);

  const empty = document.createElement('div');
  empty.className = 'flowix-emoji-picker__empty';
  empty.textContent = translate(language, 'editor.emoji.empty');
  empty.hidden = true;

  scroll.append(grid, empty);

  if (renderHeader) element.append(...renderHeader(requestClose));
  element.append(searchInput, tabs, scroll);
  if (renderFooter) element.append(...renderFooter(requestClose));

  let catalog: CalloutEmojiGroup[] | null = null;
  let emojiIndex = new Map<string, CalloutEmojiEntry>();
  let activeGroupId = 'common';
  let query = '';

  const labelOf = (entry: CalloutEmojiEntry): string => (
    language === 'zh-CN' ? entry.z : entry.n
  ) || entry.u;

  let viewItems: ViewItem[] = [];
  let viewVersion = 0;
  let frame: number | null = null;
  let renderedVersion = -1;
  let renderedStart = -1;
  let renderedEnd = -1;
  let renderedColumns = -1;
  /** Panel width is fixed for the picker's lifetime; measure the grid once. */
  let gridColumns = 0;
  const viewCache = new Map<string, ViewItem[]>();
  /**
   * Reused button nodes. Switching categories updates text/attributes on the
   * existing nodes instead of creating ~90 new elements (and a new
   * accessibility subtree) every time.
   */
  const buttonPool: HTMLButtonElement[] = [];

  const isWideEmoji = (unicode: string): boolean => {
    const codepoints = Array.from(unicode);
    return codepoints.length > 3 || codepoints.includes(ZWJ);
  };

  const measureColumns = (): boolean => {
    // The panel is often built before the host appends it to the DOM. Keep
    // the fallback width until a real one is available, then re-measure.
    const width = scroll.clientWidth;
    if (width <= 0) return false;
    const columns = Math.max(
      1,
      Math.floor((width + EMOJI_GAP) / (EMOJI_CELL_SIZE + EMOJI_GAP)),
    );
    if (columns === gridColumns) return false;
    gridColumns = columns;
    renderedColumns = -1;
    renderedVersion = -1;
    return true;
  };

  const renderWindow = () => {
    measureColumns();
    if (gridColumns === 0) {
      const width = scroll.clientWidth || EMOJI_GRID_FALLBACK_WIDTH;
      gridColumns = Math.max(
        1,
        Math.floor((width + EMOJI_GAP) / (EMOJI_CELL_SIZE + EMOJI_GAP)),
      );
    }
    const columns = gridColumns;
    const rows = Math.ceil(viewItems.length / columns);
    const totalHeight = Math.max(0, rows * EMOJI_STRIDE - EMOJI_GAP);

    grid.style.height = `${totalHeight}px`;
    windowEl.style.gridTemplateColumns = `repeat(${columns}, ${EMOJI_CELL_SIZE}px)`;

    const visibleRows =
      Math.ceil((scroll.clientHeight || EMOJI_VIEWPORT_HEIGHT) / EMOJI_STRIDE)
      + EMOJI_OVERSCAN_ROWS * 2;
    const startRow = Math.max(
      0,
      Math.floor(scroll.scrollTop / EMOJI_STRIDE) - EMOJI_OVERSCAN_ROWS,
    );
    const endRow = Math.min(rows, startRow + visibleRows);
    const start = startRow * columns;
    const end = Math.min(viewItems.length, endRow * columns);

    windowEl.style.transform = `translateY(${startRow * EMOJI_STRIDE}px)`;

    // Scrolling inside the already-rendered window changes nothing; only
    // rebuild when the visible slice (or the item list) actually moves.
    if (
      viewVersion === renderedVersion
      && start === renderedStart
      && end === renderedEnd
      && columns === renderedColumns
    ) {
      return;
    }
    renderedVersion = viewVersion;
    renderedStart = start;
    renderedEnd = end;
    renderedColumns = columns;

    const count = Math.max(0, end - start);
    while (buttonPool.length < count) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'flowix-emoji-picker__icon';
      windowEl.appendChild(button);
      buttonPool.push(button);
    }

    for (let index = 0; index < buttonPool.length; index += 1) {
      const button = buttonPool[index];
      if (index >= count) {
        if (!button.hidden) button.hidden = true;
        continue;
      }

      const item = viewItems[start + index];
      if (button.hidden) button.hidden = false;
      if (button.dataset.emoji !== item.u) button.dataset.emoji = item.u;

      const title = item.title || item.u;
      const flagUrl = item.flag ? FLAG_ASSET_URLS[item.flag] : undefined;
      if (flagUrl) {
        let image = button.querySelector('img');
        if (!image) {
          image = document.createElement('img');
          image.draggable = false;
          image.loading = 'lazy';
          button.replaceChildren(image);
        }
        if (image.getAttribute('src') !== flagUrl) image.src = flagUrl;
        if (image.alt !== title) image.alt = title;
      } else if (button.querySelector('img')) {
        button.textContent = item.u;
      } else if (button.textContent !== item.u) {
        button.textContent = item.u;
      }

      if (button.title !== title) button.title = title;
      if (button.getAttribute('aria-label') !== title) {
        button.setAttribute('aria-label', title);
      }

      // ZWJ sequences may fall back to several glyphs; scale them down so
      // adjacent cells never overlap.
      if (isWideEmoji(item.u)) {
        if (!button.hasAttribute('data-wide')) button.dataset.wide = '';
      } else if (button.hasAttribute('data-wide')) {
        delete button.dataset.wide;
      }
    }
  };

  const scheduleWindow = () => {
    if (frame !== null) return;
    frame = window.requestAnimationFrame(() => {
      frame = null;
      renderWindow();
    });
  };

  const setViewItems = (items: ViewItem[]) => {
    viewItems = items;
    viewVersion += 1;
    empty.hidden = items.length > 0;
    scroll.scrollTop = 0;
    renderWindow();
  };

  const itemsForGroup = (groupId: string): ViewItem[] => {
    const cacheKey = `${language}:${groupId}`;
    const cached = viewCache.get(cacheKey);
    if (cached) return cached;

    let items: ViewItem[];
    if (groupId === 'common') {
      items = CALLOUT_ICONS.map((icon) => {
        const entry = emojiIndex.get(icon);
        return { u: icon, title: entry ? labelOf(entry) : icon };
      });
    } else {
      const group = catalog?.find((item) => item.id === groupId);
      items = (group?.emojis ?? []).map((entry) => ({
        u: entry.u,
        title: labelOf(entry),
        flag: entry.f,
      }));
    }

    viewCache.set(cacheKey, items);
    return items;
  };

  const renderItems = () => {
    if (query) {
      const result = searchCalloutEmojis(catalog ?? [], query, CALLOUT_EMOJI_SEARCH_LIMIT);
      setViewItems(result.entries.map((entry) => ({
        u: entry.u,
        title: labelOf(entry),
        flag: entry.f,
      })));
      return;
    }

    setViewItems(itemsForGroup(activeGroupId));
  };

  // One delegated listener instead of hundreds of per-button listeners.
  grid.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>('[data-emoji]');
    const unicode = button?.dataset.emoji;
    if (!unicode) return;
    onPick(unicode);
    requestClose();
  });

  scroll.addEventListener('scroll', scheduleWindow, { passive: true });

  let tabButtons: Array<{ id: string; button: HTMLButtonElement }> = [];

  /**
   * Switching categories only flips the active marker. Rebuilding the tab
   * strip would remove the clicked button, drop focus and force a new
   * accessibility subtree on every switch.
   */
  const updateTabState = () => {
    for (const { id, button } of tabButtons) {
      const active = !query && id === activeGroupId;
      if (active) {
        if (!button.hasAttribute('data-active')) button.dataset.active = '';
      } else if (button.hasAttribute('data-active')) {
        delete button.dataset.active;
      }
      const pressed = String(active);
      if (button.getAttribute('aria-pressed') !== pressed) {
        button.setAttribute('aria-pressed', pressed);
      }
    }
  };

  const renderTabs = () => {
    tabs.replaceChildren();
    tabButtons = [];
    const items: Array<{ id: string; label: string }> = [
      { id: 'common', label: translate(language, 'editor.emoji.common') },
    ];
    for (const group of catalog ?? []) {
      items.push({
        id: group.id,
        label: language === 'zh-CN' ? group.nameZh : group.nameEn,
      });
    }

    for (const item of items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'flowix-emoji-picker__tab';
      button.textContent = item.label;
      button.addEventListener('click', () => {
        activeGroupId = item.id;
        query = '';
        searchInput.value = '';
        updateTabState();
        renderItems();
      });
      tabs.appendChild(button);
      tabButtons.push({ id: item.id, button });
    }

    updateTabState();
  };

  searchInput.addEventListener('input', () => {
    query = searchInput.value.trim();
    updateTabState();
    renderItems();
  });
  searchInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const first = grid.querySelector<HTMLButtonElement>('.flowix-emoji-picker__icon');
    if (!first) return;
    event.preventDefault();
    first.click();
  });

  renderTabs();
  renderItems();

  let destroyed = false;
  // The search field stays disabled until the catalog chunk arrives; remember
  // an early focus request so hosts can focus it as soon as it is usable.
  let focusPending = false;
  const ready = loadEmojiCatalog()
    .then((module) => {
      if (destroyed) return;
      catalog = module.CALLOUT_EMOJI_GROUPS;
      emojiIndex = indexCalloutEmojis(catalog);
      viewCache.clear();
      searchInput.disabled = false;
      searchInput.placeholder = translate(language, 'editor.emoji.search');
      renderTabs();
      renderItems();
      if (focusPending) {
        focusPending = false;
        searchInput.focus();
      }
    })
    .catch(() => {
      if (destroyed) return;
      // The common grid still works; enable search so the failure is not a
      // dead control, even though it will only search the loaded (empty) set.
      searchInput.disabled = false;
      searchInput.placeholder = translate(language, 'editor.emoji.search');
      if (focusPending) {
        focusPending = false;
        searchInput.focus();
      }
    });

  return {
    element,
    ready,
    focusSearch: () => {
      if (searchInput.disabled) {
        focusPending = true;
        return;
      }
      searchInput.focus();
    },
    refreshLayout: () => {
      if (!destroyed) renderWindow();
    },
    destroy: () => {
      destroyed = true;
      focusPending = false;
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
        frame = null;
      }
      scroll.removeEventListener('scroll', scheduleWindow);
      element.remove();
    },
  };
}
