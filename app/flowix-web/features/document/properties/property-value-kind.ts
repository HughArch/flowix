import type { PropertyKind } from '@/lib/property-types';

export const PROPERTY_URL_RE = /^https?:\/\/\S+$/i;
export const PROPERTY_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A value cannot recover option or tag semantics without a declaration. */
export function inferPropertyValueKind(value: unknown): PropertyKind {
  if (typeof value === 'boolean') return 'Boolean';
  if (Array.isArray(value)) return 'MultiSelect';
  if (typeof value === 'number') return 'Number';
  if (typeof value === 'string' && PROPERTY_DATE_RE.test(value)) return 'Date';
  if (typeof value === 'string' && PROPERTY_URL_RE.test(value)) return 'URL';
  return 'Text';
}
