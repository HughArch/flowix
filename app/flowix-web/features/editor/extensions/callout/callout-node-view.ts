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
  normalizeCalloutColor,
  normalizeCalloutIcon,
} from './callout-markdown';
import { createEmojiPickerPanel, loadEmojiCatalog } from './emoji-picker';
import { flagAssetUrlForIcon } from './flag-assets';
import { CALLOUT_PRESETS, type CalloutPresetId } from './callout-presets';

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

    const emojiPanel = createEmojiPickerPanel({
      language: getCurrentAppLanguage(),
      requestClose: () => closePicker(),
      onPick: (unicode) => updateAttributes({ icon: unicode }),
      // Built-in scenarios: one click applies icon + background together.
      renderHeader: (requestClose) => {
        const presets = document.createElement('div');
        presets.className = 'flowix-emoji-picker__presets';
        for (const preset of CALLOUT_PRESETS) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'flowix-emoji-picker__preset';
          button.dataset.preset = preset.id;
          button.style.setProperty('--flowix-preset-color', `var(--flowix-text-${preset.color})`);

          const icon = document.createElement('span');
          icon.className = 'flowix-emoji-picker__preset-icon';
          icon.textContent = preset.icon;

          const text = document.createElement('span');
          text.textContent = tKey(calloutPresetLabelKeys[preset.id]);

          button.append(icon, text);
          button.setAttribute('aria-label', text.textContent ?? '');
          button.addEventListener('click', () => {
            updateAttributes({ icon: preset.icon, color: preset.color });
            requestClose();
          });
          presets.appendChild(button);
        }
        return [presets];
      },
      renderFooter: (requestClose) => {
        const label = document.createElement('div');
        label.className = 'flowix-emoji-picker__label';
        label.textContent = tKey('editor.callout.background');

        const swatches = document.createElement('div');
        swatches.className = 'flowix-emoji-picker__swatches';
        for (const color of FLOWIX_TEXT_COLORS) {
          const swatch = document.createElement('button');
          swatch.type = 'button';
          swatch.className = 'flowix-emoji-picker__swatch';
          swatch.style.setProperty('--flowix-swatch-color', `var(--flowix-text-${color})`);
          swatch.setAttribute('aria-label', tKey(flowixColorLabelKeys[color]));
          swatch.title = tKey(flowixColorLabelKeys[color]);
          if (normalizeCalloutColor(current.attrs.color) === color) swatch.dataset.active = '';
          swatch.addEventListener('click', () => {
            updateAttributes({ color });
            requestClose();
          });
          swatches.appendChild(swatch);
        }
        return [label, swatches];
      },
    });

    const panel = emojiPanel.element;
    document.body.appendChild(panel);
    emojiPanel.refreshLayout();

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
        emojiPanel.destroy();
        if (picker === handle) picker = null;
        if (activePicker === handle) activePicker = null;
      },
    };

    picker = handle;
    activePicker = handle;

    void emojiPanel.ready.then(() => {
      if (panel.isConnected) position();
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
