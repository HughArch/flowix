/**
 * Note property preset catalog.
 *
 * Preset-specific metadata shared by frontmatter and table property editors.
 * Shared property type metadata lives in `lib/property-types.ts`. This catalog
 * is render-time only — preset metadata
 * (category, icon, mapped label) is never written to YAML frontmatter.
 *
 * Adding a built-in preset:
 *  1. Append an entry to `BUILTIN_PRESETS`.
 *  2. Add its label / hint / option i18n keys to `locales.ts` (both
 *     `zh-CN` and `en-US`).
 *  3. Add or change property kinds in `lib/property-types.ts`, then update
 *     the relevant editor when a kind needs new value behavior.
 */

import type { Icon } from '@phosphor-icons/react';
import {
  CalendarDotsIcon,
  PaletteIcon,
  PushPinIcon,
  SmileyIcon,
  TagIcon,
  TextAlignLeftIcon,
  TextTIcon,
  CheckSquareIcon,
} from '@phosphor-icons/react';
import type { I18nKey } from '@/lib/i18n';
import type { PropertyFieldConfig } from '@/lib/constants';
import { CUSTOM_PROPERTY_KINDS, PROPERTY_KINDS, type PresetPropertyKind, type PropertyKind } from '@/lib/property-types';
import { canonicalizePropertyKey } from '@features/properties/property-key';

export { CUSTOM_PROPERTY_KINDS, PROPERTY_KINDS };
export type { PropertyKind };

/**
 * Categories that drive the picker grouping. Values are camelCase to align
 * 1:1 with `document.properties.category.<value>` i18n keys in `locales.ts`.
 * Note that the YAML key for a preset (`preset.key`) is independently
 * kebab-case — category and key are separate concepts.
 */
export type PropertyCategory =
  | 'name'
  | 'description'
  | 'tags'
  | 'color'
  | 'icon'
  | 'favorite'
  | 'date'
  | 'custom';

export type PropertyPresetSource = 'builtin' | 'custom';

/** Unified runtime definition consumed by every property picker/editor. */
export interface PropertyPreset {
  id?: string;
  revision?: number;
  optionIds?: readonly string[];
  multiple?: boolean;
  source: PropertyPresetSource;
  /** Built-in category slot. Custom presets do not require a category. */
  category: PropertyCategory;
  /** The literal key written to YAML. */
  key: string;
  /** Resolved display name. Built-ins resolve this from i18n at runtime. */
  label: string;
  /** Semantic kind used by preset-bound rows; row editors keep preset kinds locked. */
  kind: PresetPropertyKind;
  /** Option values for `Select` / `MultiSelect`. */
  options?: readonly string[];
  /** Optional description / hint (i18n key). */
  hintKey?: I18nKey;
  /** Phosphor icon rendered in the picker item and the trigger button. */
  icon?: Icon;
}

interface BuiltinPropertyPreset {
  source: 'builtin';
  category: Exclude<PropertyCategory, 'custom'>;
  key: string;
  labelKey: I18nKey;
  kind: PresetPropertyKind;
  options?: readonly string[];
  icon: Icon;
}

export const BUILTIN_PRESETS: readonly BuiltinPropertyPreset[] = [
  {
    source: 'builtin',
    category: 'name',
    key: 'name',
    labelKey: 'document.properties.commonKey.name',
    kind: 'Text',
    icon: TextTIcon,
  },
  {
    source: 'builtin',
    category: 'description',
    key: 'description',
    labelKey: 'document.properties.commonKey.description',
    kind: 'Text',
    icon: TextAlignLeftIcon,
  },
  {
    source: 'builtin',
    category: 'tags',
    key: 'tags',
    labelKey: 'document.properties.category.tags',
    kind: 'Tag',
    icon: TagIcon,
  },
  {
    source: 'builtin',
    category: 'color',
    key: 'flowix_colors',
    labelKey: 'document.properties.commonKey.color',
    kind: 'Color',
    icon: PaletteIcon,
  },
  {
    source: 'builtin',
    category: 'icon',
    key: 'flowix_icon',
    labelKey: 'document.properties.category.icon',
    kind: 'Icon',
    icon: SmileyIcon,
  },
  {
    source: 'builtin',
    category: 'favorite',
    key: 'flowix_favorited',
    labelKey: 'document.action.pin',
    kind: 'Boolean',
    icon: PushPinIcon,
  },
  {
    source: 'builtin',
    category: 'name',
    key: 'status',
    labelKey: 'document.properties.commonKey.status',
    kind: 'Select',
    options: ['未开始', '进行中', '完成'],
    icon: CheckSquareIcon,
  },
  {
    source: 'builtin',
    category: 'date',
    key: 'calendar_date',
    labelKey: 'document.properties.commonKey.calendarDate',
    kind: 'Date',
    icon: CalendarDotsIcon,
  },
];

function comparablePresetKey(key: string): string {
  return canonicalizePropertyKey(key).toLowerCase();
}

const BUILTIN_PRESET_KEY_SET: ReadonlySet<string> = new Set(
  BUILTIN_PRESETS.map((preset) => comparablePresetKey(preset.key)),
);

export function isBuiltinPresetKey(key: string): boolean {
  return BUILTIN_PRESET_KEY_SET.has(comparablePresetKey(key));
}

export function getBuiltinPresets(labelResolver: (key: I18nKey) => string, storedFields: readonly PropertyFieldConfig[] = []): PropertyPreset[] {
  return BUILTIN_PRESETS.map((preset) => {
    const stored = storedFields.find((field) => comparablePresetKey(field.key) === comparablePresetKey(preset.key));
    return {
      ...preset,
      ...(stored ? { id: stored.id, revision: stored.revision, optionIds: stored.options?.map((option) => option.id), multiple: stored.multiple, kind: stored.type, options: stored.options?.map((option) => option.label) } : {}),
      label: labelResolver(preset.labelKey),
    };
  });
}

export function getCustomPresets(fields: readonly PropertyFieldConfig[]): PropertyPreset[] {
  const seenKeys = new Set(BUILTIN_PRESET_KEY_SET);
  return fields.flatMap((field) => {
    const key = field.key.trim();
    const comparableKey = comparablePresetKey(key);
    if (!key || seenKeys.has(comparableKey)) return [];
    seenKeys.add(comparableKey);
    return [{
      ...(field.id ? { id: field.id, revision: field.revision, optionIds: field.options?.map((option) => option.id), multiple: field.multiple } : {}),
      source: 'custom' as const,
      category: 'custom' as const,
      key,
      // A user preset's key IS its user-facing name. Only system presets own a
      // display name separate from their key (resolved from the builtin catalog).
      label: key,
      kind: field.type,
      options: field.type === 'Select' || field.type === 'MultiSelect'
        ? field.options?.map((option) => option.label)
        : undefined,
    }];
  });
}

export function getAllPresets(
  fields: readonly PropertyFieldConfig[],
  labelResolver: (key: I18nKey) => string,
): PropertyPreset[] {
  return [...getBuiltinPresets(labelResolver, fields), ...getCustomPresets(fields)];
}

export function resolvePropertyPreset(
  key: string,
  fields: readonly PropertyFieldConfig[] = [],
  labelResolver?: (key: I18nKey) => string,
): PropertyPreset | null {
  const trimmed = key.trim();
  if (!trimmed) return null;
  const builtin = BUILTIN_PRESETS.find(
    (preset) => comparablePresetKey(preset.key) === comparablePresetKey(trimmed),
  );
  if (builtin) {
    const stored = fields.find((field) => comparablePresetKey(field.key) === comparablePresetKey(builtin.key));
    return {
      ...builtin,
      ...(stored ? { id: stored.id, revision: stored.revision, optionIds: stored.options?.map((option) => option.id), multiple: stored.multiple, kind: stored.type, options: stored.options?.map((option) => option.label) } : {}),
      label: labelResolver?.(builtin.labelKey) ?? builtin.labelKey,
    };
  }
  return getCustomPresets(fields).find(
    (preset) => comparablePresetKey(preset.key) === comparablePresetKey(trimmed),
  ) ?? null;
}

/** Resolve the display label while keeping the YAML key canonical. */
export function resolvePropertyDisplayName(
  key: string,
  fields: readonly PropertyFieldConfig[] = [],
  labelResolver?: (key: I18nKey) => string,
): string {
  const trimmed = key.trim();
  if (!trimmed) return key;
  if (canonicalizePropertyKey(trimmed).toLowerCase() === 'flowix_plugin') {
    return labelResolver?.('document.properties.commonKey.plugin') ?? 'document.properties.commonKey.plugin';
  }
  if (canonicalizePropertyKey(trimmed).toLowerCase() === 'note') {
    return labelResolver?.('document.properties.type.note') ?? 'document.properties.type.note';
  }
  return resolvePropertyPreset(trimmed, fields, labelResolver)?.label ?? trimmed;
}
