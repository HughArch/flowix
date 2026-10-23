import type { I18nKey, translate } from '@/lib/i18n';
import type { PropertyKind, PropertyDisplayKind } from '@/lib/property-types';
import { NOTE_COLORS, NOTE_COLOR_HEX } from '@features/memo/store/note-store';
import type { NoteColor } from '@/types/note-item';
import { formatFrontmatterPropertyValue } from '@features/document/properties/frontmatter-model';
import { getPropertyIconOption } from '@features/document/properties/property-icons';
import { resolvePropertyType } from '@features/document/properties/property-type';
import { canonicalizePropertyKey } from '@features/properties/property-key';
import { createOptionChip } from './frontmatter-property-editor';

function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

const FLOWIX_COLOR_LABEL_KEYS: Record<NoteColor, I18nKey> = {
  red: 'document.color.red',
  orange: 'document.color.orange',
  yellow: 'document.color.yellow',
  green: 'document.color.green',
  cyan: 'document.color.cyan',
  blue: 'document.color.blue',
  gray: 'document.color.gray',
};

function createTextValue(value: unknown): HTMLElement {
  const text = createElement('span', 'frontmatter-property__value-text');
  // Keep the complete value here; the value cell controls wrapping within its
  // available width instead of silently losing content in the view layer.
  text.textContent = formatFrontmatterPropertyValue(value, Number.POSITIVE_INFINITY);
  return text;
}

export function renderFrontmatterPropertyValue(
  property: { key: string; value: unknown },
  kind: PropertyDisplayKind,
  propertyKind: PropertyKind,
  options: {
    isEditable: () => boolean;
    onBooleanChange: (value: boolean) => void;
    t: (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => string;
  },
): HTMLElement {
  const valueContainer = createElement('div', 'frontmatter-property__display-value');
  if (
    property.value === ''
    || property.value === null
    || property.value === undefined
    || (Array.isArray(property.value) && property.value.length === 0)
  ) {
    valueContainer.append(createElement(
      'span',
      'frontmatter-property__value-text frontmatter-property__value-text--fallback',
      options.t('document.properties.notSet'),
    ));
    return valueContainer;
  }

  if (
    property.key === 'flowix_plugin'
    && typeof property.value === 'object'
    && !Array.isArray(property.value)
  ) {
    valueContainer.append(createTextValue(JSON.stringify(property.value)));
    return valueContainer;
  }

  if (propertyKind === 'Select' && typeof property.value === 'string') {
    valueContainer.append(createOptionChip(property.value));
    return valueContainer;
  }

  if (propertyKind === 'MultiSelect') {
    const values = Array.isArray(property.value)
      ? property.value.map(String).filter(Boolean)
      : String(property.value).split(',').map((item) => item.trim()).filter(Boolean);
    const chips = createElement('div', 'frontmatter-property__value-chips');
    values.forEach((value) => chips.append(createOptionChip(value, true)));
    valueContainer.append(chips);
    return valueContainer;
  }

  if (propertyKind === 'Tag' && canonicalizePropertyKey(property.key) !== 'tags') {
    const values = Array.isArray(property.value)
      ? property.value.map(String).filter(Boolean)
      : String(property.value).split(',').map((item) => item.trim()).filter(Boolean);
    const chips = createElement(
      'div',
      'frontmatter-property__value-chips frontmatter-property__value-chips--tag-values',
    );
    values.forEach((value) => {
      const chip = createElement(
        'span',
        'frontmatter-property__value-chip frontmatter-property__value-chip--tag',
      );
      chip.append(createElement('span', 'tag-node-content', value));
      chip.title = value;
      chips.append(chip);
    });
    valueContainer.append(chips);
    return valueContainer;
  }

  if (kind === 'boolean') {
    const checkbox = createElement('input', 'frontmatter-property__value-checkbox flowix-hand-checkbox-input');
    checkbox.type = 'checkbox';
    checkbox.checked = property.value === true;
    checkbox.disabled = !options.isEditable();
    checkbox.setAttribute('aria-label', property.key);
    checkbox.setAttribute('data-property-key', property.key);
    checkbox.setAttribute('data-property-type', 'Select');
    checkbox.addEventListener('change', () => {
      options.onBooleanChange(checkbox.checked);
    });
    valueContainer.classList.add('frontmatter-property__display-value--checkbox');
    valueContainer.append(checkbox);
    return valueContainer;
  }

  if (kind === 'array' || kind === 'color') {
    if (!Array.isArray(property.value)) {
      valueContainer.append(createTextValue(property.value));
      return valueContainer;
    }
    const values = Array.isArray(property.value) ? property.value : [];
    if (values.length === 0) {
      valueContainer.append(createTextValue('[]'));
      return valueContainer;
    }

    if (kind === 'color') {
      const colorDots = createElement('div', 'frontmatter-property__value-color-dots');
      values.forEach((item) => {
        const color = String(item).trim();
        if (!NOTE_COLORS.includes(color as NoteColor)) return;
        const dot = createElement('span', 'frontmatter-property__value-color-dot');
        const label = options.t(FLOWIX_COLOR_LABEL_KEYS[color as NoteColor]);
        dot.dataset.value = color;
        dot.setAttribute('role', 'img');
        dot.setAttribute('aria-label', label);
        dot.title = label;
        dot.style.setProperty('--frontmatter-color', NOTE_COLOR_HEX[color as NoteColor]);
        colorDots.append(dot);
      });
      valueContainer.append(colorDots);
      return valueContainer;
    }

    const isNoteTags = canonicalizePropertyKey(property.key) === 'tags';
    const isTagValues = values.every(
      (item) => resolvePropertyType('', item).displayKind === 'text',
    );
    const chips = createElement(
      'div',
      `frontmatter-property__value-chips${isTagValues ? ' frontmatter-property__value-chips--tag-values' : ''}`,
    );
    values.forEach((item) => {
      const displayValue = formatFrontmatterPropertyValue(item, 32);
      const itemDisplayKind = resolvePropertyType('', item).displayKind;
      const chip = createElement(
        'span',
        `${isNoteTags ? 'tag-node ' : ''}frontmatter-property__value-chip${itemDisplayKind === 'text' ? '' : ' frontmatter-property__value-chip--typed'}`,
      );
      if (isNoteTags) {
        chip.append(
          createElement('span', 'tag-node-prefix', '#'),
          createElement('span', 'tag-node-content', displayValue),
        );
      } else {
        chip.textContent = displayValue;
      }
      chip.title = formatFrontmatterPropertyValue(item, Number.POSITIVE_INFINITY);
      chips.append(chip);
    });
    valueContainer.append(chips);
    return valueContainer;
  }

  if (kind === 'icon') {
    const iconOption = getPropertyIconOption(String(property.value ?? ''));
    if (iconOption) {
      const image = document.createElement('img');
      image.className = 'frontmatter-property__value-icon';
      image.src = iconOption.src;
      image.alt = iconOption.label;
      image.title = iconOption.label;
      valueContainer.append(image);
      return valueContainer;
    }
  }

  if (kind === 'url' && typeof property.value === 'string') {
    const link = createElement('a', 'frontmatter-property__value-text frontmatter-property__value-text--url', property.value);
    link.href = property.value;
    link.target = '_blank';
    link.rel = 'noreferrer noopener';
    link.title = property.value;
    valueContainer.append(link);
    return valueContainer;
  }

  valueContainer.append(createTextValue(property.value));
  return valueContainer;
}
