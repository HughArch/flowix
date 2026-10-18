import { create } from 'zustand';
import type { PropertiesConfig, PropertyFieldConfig, PropertyFieldType } from './types';
import { propertyPresets, type PropertyPresetChange } from '@platform/tauri/client/properties';
import { legacyPropertyId, createPropertyOptionId } from '@/lib/property-identity';
import { isPresetPropertyKind } from '@/lib/property-types';
import { canonicalizePropertyKey, isSystemPropertyKey } from './property-key';

export function sanitizePropertiesConfig(properties: PropertiesConfig | undefined, previousRegistry: PropertiesConfig = { fields: [] }): PropertiesConfig {
  const systemFields = (properties?.systemFields ?? []).filter((field) => isSystemPropertyKey(field.key) && isPresetPropertyKind(field.type))
    .map((field) => ({ ...field, options: normalizePresetOptions(field), id: /^fld_[0-9a-f]{32}$/.test(field.id ?? '') ? field.id : legacyPropertyId(`system:${field.key}`), revision: Math.max(1, field.revision ?? 1) }));
  const fields = Array.isArray(properties?.fields) ? properties.fields : [];
  const deduped = new Map<string, PropertiesConfig['fields'][number]>();

  fields.forEach((field, position) => {
    if (!field || typeof field !== 'object' || Array.isArray(field)) return;
    const key = String(field?.key ?? '').trim();
    const rawType = (field as { type?: unknown })?.type;
    // Map removed type names at the settings boundary so runtime code only
    // sees the canonical property kinds.
    const normalizedType = rawType === 'List' ? 'MultiSelect' : (rawType === 'Tags' || rawType === 'noteTag') ? 'Tag' : rawType;
    if (!key || canonicalizePropertyKey(key).toLowerCase() === 'flowix_property_types') return;
    if (!isPresetPropertyKind(normalizedType)) return;
    const type: PropertyFieldType = normalizedType;
    // Built-in presets own their keys. Filtering them here keeps malformed or
    // externally-written settings from shadowing the unified runtime catalog.
    if (isSystemPropertyKey(key)) return;
    const comparableKey = canonicalizePropertyKey(key).toLowerCase();
    if (deduped.has(comparableKey)) return;
    const previous = previousRegistry.fields.find((item) => canonicalizePropertyKey(item.key).toLowerCase() === comparableKey);
    const id = /^fld_[0-9a-f]{32}$/.test(field.id ?? '') ? field.id! : previous?.id ?? legacyPropertyId(comparableKey);
    const options = (type === 'Select' || type === 'MultiSelect') && Array.isArray(field.options)
      ? normalizePresetOptions(field, previous) : undefined;
    const name = typeof field.name === 'string' ? field.name.trim() : '';
    const rawRevision = typeof field.revision === 'number' && Number.isFinite(field.revision)
      ? field.revision
      : previous?.revision ?? 1;
    deduped.set(comparableKey, {
      id, position, name: name || undefined, revision: Math.max(1, rawRevision),
      multiple: type === 'Image' ? field.multiple !== false : undefined,
      key,
      type,
      options,
    });
  });

  const deletedFields = (Array.isArray(properties?.deletedFields) ? properties.deletedFields : [])
    .filter((field): field is PropertyFieldConfig => Boolean(
      field
      && typeof field === 'object'
      && !Array.isArray(field)
      && typeof field.id === 'string'
      && /^fld_[0-9a-f]{32}$/.test(field.id)
      && isPresetPropertyKind(field.type),
    ));
  return { systemFields, fields: [...deduped.values()], ...(deletedFields.length ? { deletedFields } : {}) };
}

/** Legacy parallel arrays are accepted only here, at the import boundary. */
function normalizePresetOptions(field: PropertyFieldConfig, previous?: PropertyFieldConfig) {
  const legacy = field as unknown as { options?: Array<string | { id: string; label: string }>; optionIds?: string[] };
  const seen = new Set<string>();
  return (legacy.options ?? []).flatMap((option, index) => {
    const label = (typeof option === 'string' ? option : option.label).trim();
    if (!label || seen.has(label)) return [];
    seen.add(label);
    const rawId = typeof option === 'string' ? legacy.optionIds?.[index] : option.id;
    const id = rawId && /^opt_[0-9a-f]{32}$/.test(rawId) ? rawId
      : previous?.options?.find((item) => item.label === label)?.id ?? createPropertyOptionId();
    return [{ id, label }];
  });
}

interface PropertyPresetState {
  registry: PropertiesConfig;
  loaded: boolean;
  load: () => Promise<void>;
}
let loadSequence = 0;
export const usePropertyPresetStore = create<PropertyPresetState>((set) => ({
  registry: { fields: [], systemFields: [], deletedFields: [] },
  loaded: false,
  load: async () => {
    const sequence = ++loadSequence;
    const registry = await propertyPresets.get();
    if (sequence !== loadSequence) return;
    if (sequence === loadSequence) set({ registry: sanitizePropertiesConfig(registry, registry), loaded: true });
  },
}));

function definition(field: PropertyFieldConfig): string {
  return JSON.stringify([field.key, field.name ?? '', field.type, field.options ?? [], field.multiple ?? true, field.position ?? 0]);
}
function registryChanges(previous: PropertiesConfig, next: PropertiesConfig): PropertyPresetChange[] {
  const old = new Map([
    ...(previous.systemFields ?? []), ...previous.fields, ...(previous.deletedFields ?? []),
  ].map((field) => [field.id, field]));
  const changes: PropertyPresetChange[] = [];
  for (const [scope, fields] of [
    ['system', next.systemFields ?? []], ['user', next.fields], ['deleted_user', next.deletedFields ?? []],
  ] as const) {
    for (const field of fields) {
      const current = old.get(field.id);
      const retired = scope === 'deleted_user' && previous.fields.some((item) => item.id === field.id);
      if (!current || retired || definition(current) !== definition(field)) {
        changes.push({ scope, field, expectedRevision: current?.revision ?? null });
      }
    }
  }
  return changes;
}

/** Only changed IDs are sent; unrelated cached fields never overwrite the DB. */
export async function persistPropertyRegistry(
  fields: PropertyFieldConfig[],
  deletedFields = usePropertyPresetStore.getState().registry.deletedFields ?? [],
  systemFields = usePropertyPresetStore.getState().registry.systemFields ?? [],
): Promise<void> {
  const previous = usePropertyPresetStore.getState().registry;
  const next = sanitizePropertiesConfig({ fields, deletedFields, systemFields }, previous);
  const changes = registryChanges(previous, next);
  if (!changes.length) return;
  const saved = await propertyPresets.patch(changes);
  ++loadSequence;
  usePropertyPresetStore.setState({ registry: sanitizePropertiesConfig(saved, saved), loaded: true });
}

export async function savePropertyPreset(field: PropertyFieldConfig, expectedRevision: number | null): Promise<void> {
  const registry = usePropertyPresetStore.getState().registry;
  const current = [...(registry.systemFields ?? []), ...registry.fields].find((item) => item.id === field.id);
  field = { ...field, position: current?.position ?? field.position ?? registry.fields.length };
  const scope = registry.systemFields?.some((item) => item.id === field.id) ? 'system' : 'user';
  const saved = await propertyPresets.patch([{ scope, field, expectedRevision }]);
  ++loadSequence;
  usePropertyPresetStore.setState({ registry: sanitizePropertiesConfig(saved, saved), loaded: true });
}

export function getPropertyPresets(): PropertyFieldConfig[] {
  const registry = usePropertyPresetStore.getState().registry;
  return [...(registry.systemFields ?? []), ...registry.fields];
}
export function subscribePropertyPresets(listener: () => void): () => void {
  return usePropertyPresetStore.subscribe((state, previous) => {
    if (state.registry !== previous.registry) listener();
  });
}

export function getRetiredPropertyKind(key: string) {
  return usePropertyPresetStore.getState().registry.deletedFields?.find((field) => canonicalizePropertyKey(field.key) === canonicalizePropertyKey(key))?.type;
}
