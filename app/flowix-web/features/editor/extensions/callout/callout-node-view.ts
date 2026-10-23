import type { NodeViewRendererProps } from '@tiptap/core';
import type { Node as PMNode } from 'prosemirror-model';
import type { ViewMutationRecord } from 'prosemirror-view';
import { translate, type I18nKey } from '@/lib/i18n';
import { getCurrentAppLanguage } from '@features/preferences/public/runtime-api';
import {
  FLOWIX_TEXT_COLORS,
  type FlowixTextColor,
} from '@features/editor/extensions/flowix-text-mark';
import {
  CALLOUT_ICONS,
  normalizeCalloutColor,
  normalizeCalloutIcon,
} from './callout-markdown';
import {
  CALLOUT_EMOJI_SEARCH_LIMIT,
  indexCalloutEmojis,
  searchCalloutEmojis,
} from './callout-emoji';
import type { CalloutEmojiEntry, CalloutEmojiGroup } from './emoji-catalog';
import { flagAssetUrlForIcon, FLAG_ASSET_URLS } from './flag-assets';
import { CALLOUT_PRESETS, type CalloutPresetId } from './callout-presets';

// The full catalog is ~220 KB, so it is split into its own chunk and only
// fetched the first time a picker opens. The "common" grid renders from the
// static list immediately, so the picker never waits on the chunk.
type EmojiCatalogModule = typeof import('./emoji-catalog');
let emojiCatalogPromise: Promise<EmojiCatalogModule> | null = null;

function loadEmojiCatalog(): Promise<EmojiCatalogModule> {
  emojiCatalogPromise ??= import('./emoji-catalog');
  return emojiCatalogPromise;
}

/** Zero-width joiner: marks emoji sequences that may render as multiple glyphs. */
const ZWJ = String.fromCharCode(0x200d);

// Virtual grid geometry. `EMOJI_VIEWPORT_HEIGHT` mirrors the CSS max-height of
// `.flowix-callout-picker__scroll`; the grid only renders the rows around the
// viewport so switching categories never builds hundreds of buttons.
const EMOJI_CELL_SIZE = 28;
const EMOJI_GAP = 2;
const EMOJI_STRIDE = EMOJI_CELL_SIZE + EMOJI_GAP;
const EMOJI_OVERSCAN_ROWS = 1;
const EMOJI_VIEWPORT_HEIGHT = 190;
const EMOJI_GRID_FALLBACK_WIDTH = 300;

// NodeViews live outside the React tree and cannot use useI18n.
function tKey(key: I18nKey): string {
  return translate(getCurrentAppLanguage(), key);
}

const flowixColorLabelKeys: Record<FlowixTextColor, I18nKey> = {
  red: 'editor.highlight.red',
  orange: 'editor.highlight.orange',
  yellow: 'editor.highlight.yellow',
  green: 'editor.highlight.green',
  cyan: 'editor.highlight.cyan',
  blue: 'editor.highlight.blue',
  purple: 'editor.highlight.purple',
  pink: 'editor.highlight.pink',
  gray: 'editor.highlight.gray',
};

const calloutPresetLabelKeys: Record<CalloutPresetId, I18nKey> = {
  info: 'editor.callout.preset.info',
  success: 'editor.callout.preset.success',
  warning: 'editor.callout.preset.warning',
  error: 'editor.callout.preset.error',
};

interface CalloutPickerHandle {
  owner: number;
  close: () => void;
}

let activePicker: CalloutPickerHandle | null = null;
let pickerSequence = 0;

function closeActivePicker(): void {
  const picker = activePicker;
  activePicker = null;
  picker?.close();
}

export function calloutNodeView({ node, getPos, editor }: NodeViewRendererProps) {
  const dom = document.createElement('div');
  dom.className = 'flowix-callout';

  const iconButton = document.createElement('button');
  iconButton.type = 'button';
  iconButton.className = 'flowix-callout-icon';
  iconButton.contentEditable = 'false';
  iconButton.setAttribute('aria-label', tKey('editor.callout.chooseIcon'));
  iconButton.title = tKey('editor.callout.chooseIcon');
  dom.appendChild(iconButton);

  const contentDOM = document.createElement('div');
  contentDOM.className = 'flowix-callout-content';
  dom.appendChild(contentDOM);

  const ownerId = ++pickerSequence;
  let current = node;
  let picker: CalloutPickerHandle | null = null;
  let renderedIcon = '';

  const sync = (next: PMNode) => {
    current = next;
    const icon = normalizeCalloutIcon(next.attrs.icon);
    const color = normalizeCalloutColor(next.attrs.color);

    if (renderedIcon !== icon) {
      renderedIcon = icon;
      // Flags have no glyph on Windows; render the bundled SVG instead.
      const flagUrl = flagAssetUrlForIcon(icon);
      if (flagUrl) {
        const image = document.createElement('img');
        image.src = flagUrl;
        image.alt = icon;
        image.draggable = false;
        iconButton.replaceChildren(image);
      } else {
        iconButton.textContent = icon;
      }
    }

    dom.dataset.icon = icon;
    dom.dataset.color = color;
  };

  const updateAttributes = (patch: { icon?: string; color?: FlowixTextColor }) => {
    if (editor.isDestroyed) return;
    const pos = typeof getPos === 'function' ? getPos() : undefined;
    if (typeof pos !== 'number') return;

    // `getPos()` may point at a node that has already been replaced; always
    // re-read the live node before merging attrs.
    const live = editor.state.doc.nodeAt(pos);
    if (!live || live.type.name !== 'callout') return;
    editor.view.dispatch(
      editor.state.tr
        .setNodeMarkup(pos, undefined, { ...live.attrs, ...patch })
        .scrollIntoView(),
    );
  };

  const closePicker = () => {
    picker?.close();
  };

  const openPicker = () => {
    if (picker) return;
    closeActivePicker();

    const language = getCurrentAppLanguage();
    const panel = document.createElement('div');
    panel.className = 'flowix-callout-picker';
    panel.contentEditable = 'false';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', tKey('editor.callout.chooseIcon'));

    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'flowix-callout-picker__search';
    searchInput.placeholder = tKey('editor.callout.loading');
    searchInput.disabled = true;
    searchInput.setAttribute('aria-label', tKey('editor.callout.searchEmoji'));

    const tabs = document.createElement('div');
    tabs.className = 'flowix-callout-picker__tabs';

    const scroll = document.createElement('div');
    scroll.className = 'flowix-callout-picker__scroll';

    const grid = document.createElement('div');
    grid.className = 'flowix-callout-picker__grid';

    const windowEl = document.createElement('div');
    windowEl.className = 'flowix-callout-picker__window';
    grid.appendChild(windowEl);

    const empty = document.createElement('div');
    empty.className = 'flowix-callout-picker__empty';
    empty.textContent = tKey('editor.callout.noEmoji');
    empty.hidden = true;

    scroll.append(grid, empty);

    const label = document.createElement('div');
    label.className = 'flowix-callout-picker__label';
    label.textContent = tKey('editor.callout.background');

    const swatches = document.createElement('div');
    swatches.className = 'flowix-callout-picker__swatches';
    for (const color of FLOWIX_TEXT_COLORS) {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'flowix-callout-picker__swatch';
      swatch.style.setProperty('--flowix-swatch-color', `var(--flowix-text-${color})`);
      swatch.setAttribute('aria-label', tKey(flowixColorLabelKeys[color]));
      swatch.title = tKey(flowixColorLabelKeys[color]);
      if (normalizeCalloutColor(current.attrs.color) === color) swatch.dataset.active = '';
      swatch.addEventListener('click', () => {
        updateAttributes({ color });
        closePicker();
      });
      swatches.appendChild(swatch);
    }

    const presets = document.createElement('div');
    presets.className = 'flowix-callout-picker__presets';
    for (const preset of CALLOUT_PRESETS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'flowix-callout-picker__preset';
      button.dataset.preset = preset.id;
      button.style.setProperty('--flowix-preset-color', `var(--flowix-text-${preset.color})`);

      const icon = document.createElement('span');
      icon.className = 'flowix-callout-picker__preset-icon';
      icon.textContent = preset.icon;

      const text = document.createElement('span');
      text.textContent = tKey(calloutPresetLabelKeys[preset.id]);

      button.append(icon, text);
      button.setAttribute('aria-label', text.textContent ?? '');
      button.addEventListener('click', () => {
        updateAttributes({ icon: preset.icon, color: preset.color });
        closePicker();
      });
      presets.appendChild(button);
    }

    panel.append(presets, searchInput, tabs, scroll, label, swatches);

    let catalog: CalloutEmojiGroup[] | null = null;
    let emojiIndex = new Map<string, CalloutEmojiEntry>();
    let activeGroupId = 'common';
    let query = '';

    const labelOf = (entry: CalloutEmojiEntry): string => (
      language === 'zh-CN' ? entry.z : entry.n
    ) || entry.u;

    interface ViewItem {
      u: string;
      title: string;
      /** Lowercase hexcode when the emoji has bundled flag artwork. */
      flag?: string;
    }

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

    const renderWindow = () => {
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
        Math.ceil(EMOJI_VIEWPORT_HEIGHT / EMOJI_STRIDE) + EMOJI_OVERSCAN_ROWS * 2;
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
        button.className = 'flowix-callout-picker__icon';
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
      updateAttributes({ icon: unicode });
      closePicker();
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
        { id: 'common', label: tKey('editor.callout.common') },
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
        button.className = 'flowix-callout-picker__tab';
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
      const first = grid.querySelector<HTMLButtonElement>('.flowix-callout-picker__icon');
      if (!first) return;
      event.preventDefault();
      first.click();
    });

    document.body.appendChild(panel);
    renderTabs();
    renderItems();

    const position = () => {
      const rect = iconButton.getBoundingClientRect();
      const margin = 8;
      const width = panel.offsetWidth;
      const height = panel.offsetHeight;
      const left = Math.min(
        Math.max(margin, rect.left),
        Math.max(margin, window.innerWidth - width - margin),
      );
      const below = rect.bottom + 6;
      const top = below + height > window.innerHeight - margin
        ? Math.max(margin, rect.top - height - 6)
        : below;
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    };
    position();

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panel.contains(target) || iconButton.contains(target)) return;
      closePicker();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closePicker();
    };
    const handleScroll = (event: Event) => {
      // The emoji grid and tab strip scroll inside the panel; only dismiss on
      // scrolls that happen in the editor behind it.
      if (event.target instanceof Node && panel.contains(event.target)) return;
      closePicker();
    };
    const handleDismiss = () => closePicker();

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('resize', handleDismiss);
    window.addEventListener('scroll', handleScroll, true);

    const handle: CalloutPickerHandle = {
      owner: ownerId,
      close: () => {
        document.removeEventListener('pointerdown', handlePointerDown, true);
        document.removeEventListener('keydown', handleKeyDown, true);
        window.removeEventListener('resize', handleDismiss);
        window.removeEventListener('scroll', handleScroll, true);
        scroll.removeEventListener('scroll', scheduleWindow);
        if (frame !== null) {
          window.cancelAnimationFrame(frame);
          frame = null;
        }
        panel.remove();
        if (picker === handle) picker = null;
        if (activePicker === handle) activePicker = null;
      },
    };

    picker = handle;
    activePicker = handle;

    void loadEmojiCatalog()
      .then((module) => {
        if (!panel.isConnected) return;
        catalog = module.CALLOUT_EMOJI_GROUPS;
        emojiIndex = indexCalloutEmojis(catalog);
        viewCache.clear();
        searchInput.disabled = false;
        searchInput.placeholder = tKey('editor.callout.searchEmoji');
        renderTabs();
        renderItems();
        position();
      })
      .catch(() => {
        if (!panel.isConnected) return;
        // The common grid still works; enable search so the failure is not a
        // dead control, even though it will only search the loaded (empty) set.
        searchInput.disabled = false;
        searchInput.placeholder = tKey('editor.callout.searchEmoji');
      });
  };

  iconButton.addEventListener('mousedown', (event) => event.preventDefault());
  // Warm the lazy catalog chunk as soon as the pointer reaches the icon, so
  // the first picker open usually has the data ready.
  iconButton.addEventListener('pointerenter', () => {
    void loadEmojiCatalog().catch(() => {});
  }, { once: true });
  iconButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (picker) closePicker();
    else openPicker();
  });

  sync(node);

  return {
    dom,
    contentDOM,
    update(updatedNode: PMNode) {
      if (updatedNode.type.name !== 'callout') return false;
      sync(updatedNode);
      return true;
    },
    destroy() {
      closePicker();
    },
    stopEvent(event: Event) {
      return event.target instanceof Node && iconButton.contains(event.target);
    },
    ignoreMutation(mutation: ViewMutationRecord) {
      return !contentDOM.contains(mutation.target as Node);
    },
  };
}
