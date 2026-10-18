import { getRetiredPropertyKind } from '@features/properties/public-api';
import { canonicalizePropertyKey } from '@features/properties/property-key';
import type { PropertyFieldConfig } from '@/lib/constants';
import { getPropertyTypeDefinition, type PropertyDisplayKind, type PropertyKind } from '@/lib/property-types';
import { resolvePropertyPreset } from './presets';
export { PROPERTY_URL_RE, PROPERTY_DATE_RE } from './property-value-kind';
import { inferPropertyValueKind } from './property-value-kind';
import { readPropertyTypes } from './property-type-metadata';

export type { PropertyDisplayKind } from '@/lib/property-types';

export interface ResolvedPropertyType {
  kind: PropertyKind;
  displayKind: PropertyDisplayKind;
}

export function resolvePropertyType(
  key: string,
  value: unknown,
  _isFlowSequence = false,
  customPresets: readonly PropertyFieldConfig[] = [],
  declaredTypes: unknown = {},
): ResolvedPropertyType {
  const canonicalKey = canonicalizePropertyKey(key);
  const kind = resolvePropertyPreset(canonicalKey, customPresets)?.kind
    ?? readPropertyTypes(declaredTypes)[canonicalKey]
    ?? getRetiredPropertyKind(canonicalKey)
    ?? inferPropertyValueKind(value);

  return {
    kind,
    // Keep the legacy key-based color rendering for documents created before
    // Color became an explicit semantic preset type.
    displayKind: canonicalKey === 'flowix_colors'
      ? 'color'
      : kind === 'Select' && typeof value === 'boolean'
        ? 'boolean'
        : getPropertyTypeDefinition(kind).displayKind,
  };
}
