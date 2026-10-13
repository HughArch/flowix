import { getRetiredPropertyKind } from '@features/properties/public-api';
import { isMap, YAMLMap } from 'yaml';
import { isPropertyKind, type PropertyKind } from '@/lib/property-types';
import { getPropertyPresets } from '@features/properties/public-api';
import { resolvePropertyPreset } from './presets';
import { inferPropertyValueKind } from './property-value-kind';
import { canonicalizePropertyKey } from '@features/properties/property-key';

export const PROPERTY_TYPES_KEY = 'flowix_property_types';

export function readPropertyTypes(value: unknown): Record<string, PropertyKind> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, raw]) => {
    const kind = raw === 'Tags' || raw === 'noteTag' ? 'Tag' : raw;
    return isPropertyKind(kind) ? [[canonicalizePropertyKey(key), kind]] : [];
  }));
}

/** Patch only the affected type entries; keep unrelated declarations and comments. */
export function patchPropertyTypes(map: YAMLMap, changes: Record<string, PropertyKind | null | undefined>, forceNonPresetKeys: readonly string[] = []): void {
  let types = map.get(PROPERTY_TYPES_KEY, true);
  if (types != null && !isMap(types)) throw new Error('flowix_property_types must be a mapping');
  const forced = new Set(forceNonPresetKeys.map(canonicalizePropertyKey));
  for (const [rawKey, kind] of Object.entries(changes)) {
    const key = canonicalizePropertyKey(rawKey);
    if (kind === undefined || key === PROPERTY_TYPES_KEY || key === 'key' || key === 'flowix_key') continue;
    // Text is the default fallback and Date is inferred from the value, so
    // neither is worth persisting. Declarations for them are removed even when
    // forced: the value alone recovers the same kind.
    if (kind === null || kind === 'Text' || kind === 'Date'
      || (!forced.has(key) && resolvePropertyPreset(key, getPropertyPresets()) !== null)) {
      if (isMap(types)) types.delete(key);
    } else {
      if (!isPropertyKind(kind)) throw new Error('Invalid property type');
      if (!isMap(types)) {
        map.set(PROPERTY_TYPES_KEY, new YAMLMap());
        types = map.get(PROPERTY_TYPES_KEY, true);
      }
      if (isMap(types)) types.set(key, kind);
    }
  }
  if (isMap(types) && types.items.length === 0) map.delete(PROPERTY_TYPES_KEY);
}

/** Complete legacy metadata only at an attribute-save boundary, never during reads. */
export function backfillPropertyTypes(map: YAMLMap, data: Record<string, unknown>, skipKeys: readonly string[] = [], forceNonPresetKeys: readonly string[] = []): void {
  const declared = readPropertyTypes(data[PROPERTY_TYPES_KEY]);
  const changes: Record<string, PropertyKind | null> = {};
  const excluded = new Set(['flowix_key', 'key', 'flowix_plugin', PROPERTY_TYPES_KEY, ...skipKeys]);
  const existing = map.get(PROPERTY_TYPES_KEY, true);
  if (isMap(existing)) {
    for (const pair of existing.items) {
      const rawKey = String(pair.key);
      const key = canonicalizePropertyKey(rawKey);
      if (!Object.prototype.hasOwnProperty.call(data, key) || excluded.has(key)) changes[rawKey] = null;
    }
  }
  for (const [rawKey, value] of Object.entries(data)) {
    const key = canonicalizePropertyKey(rawKey);
    if (excluded.has(key)) continue;
    changes[key] = declared[key]
      ?? getRetiredPropertyKind(key)
      ?? inferPropertyValueKind(value);
  }
  patchPropertyTypes(map, changes, forceNonPresetKeys);
}
