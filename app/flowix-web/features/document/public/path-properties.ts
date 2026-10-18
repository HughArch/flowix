import { resolvePropertyType } from '../properties/property-type';
import { getPropertyPresets } from '@features/properties/public-api';
import { PROPERTY_TYPES_KEY, backfillPropertyTypes, patchPropertyTypes, readPropertyTypes } from '../properties/property-type-metadata';
import type { PropertyKind } from '@/lib/property-types';
import { isMap, parseDocument } from 'yaml';
import { ensureFileDisplayIdentity, findFileDisplayPath, pinFileDisplayId } from '@/lib/file-display-registry';
import { documentIdentityFromFile } from '../store/document-identity';
import { getBuffer, applyLoadedContent } from '../store/buffer-registry';
import { captureLatestDocumentContent, recordDocumentEdit, saveDocumentContent } from '../store/document-session-service';
import { memoDocumentOperations } from '../use-cases/memo-document-operations';

/** Change only YAML properties; preserve authored body bytes and YAML comments. */
export function patchDocumentProperties(content: string, properties: Record<string, unknown>, removedProperties: string[] = [], types: Record<string, PropertyKind | null | undefined> = {}, forceNonPresetKeys: readonly string[] = []): string {
  const match = /^\uFEFF?(?:[ \t]*\r?\n)*---\r?\n((?:[^\r\n]*\r?\n)*?)---(?:\r?\n|$)/.exec(content);
  if (!match && Object.keys(properties).length === 0) return content;
  const document = parseDocument(match?.[1] ?? '');
  if (document.errors.length) throw new Error(document.errors[0].message);
  if (document.contents && !isMap(document.contents)) throw new Error('Frontmatter must be a mapping');
  const previousData = document.toJS() ?? {};
  const previousTypes = readPropertyTypes(previousData[PROPERTY_TYPES_KEY]);
  for (const [key, value] of Object.entries(properties)) {
    if (key === 'flowix_key' || key === 'key' || key === PROPERTY_TYPES_KEY) throw new Error('Identity properties cannot be generated');
    document.set(key, value);
  }
  for (const key of removedProperties) {
    if (key === 'flowix_key' || key === 'key' || key === PROPERTY_TYPES_KEY) throw new Error('Identity properties cannot be removed');
    document.delete(key);
  }
  const typeChanges: Record<string, PropertyKind | null | undefined> = {
    ...Object.fromEntries(removedProperties.map((key) => [key, null])),
    ...types,
  };
  for (const [key, value] of Object.entries(properties)) {
    if (types[key] !== undefined) continue;
    const previousValue = Object.prototype.hasOwnProperty.call(previousData, key) ? previousData[key] : value;
    typeChanges[key] = resolvePropertyType(key, previousValue, false, getPropertyPresets(), previousTypes).kind;
  }
  // Guarded key migrations move a single property and its existing declaration.
  const addedKeys = Object.keys(properties);
  if (removedProperties.length === 1 && addedKeys.length === 1 && types[addedKeys[0]] === undefined) {
    typeChanges[addedKeys[0]] = resolvePropertyType(removedProperties[0], previousData[removedProperties[0]], false, getPropertyPresets(), previousTypes).kind;
  }
  if (!isMap(document.contents)) document.set(PROPERTY_TYPES_KEY, {});
  if (isMap(document.contents)) {
    patchPropertyTypes(document.contents, typeChanges, forceNonPresetKeys);
    backfillPropertyTypes(document.contents, document.toJS() ?? {}, Object.keys(types).filter((key) => types[key] === null), forceNonPresetKeys);
  }
  const body = match ? content.slice(match[0].length) : content.replace(/^\uFEFF/, '');
  return '---\n' + document.toString() + '---\n' + body;
}

/** Property controls and text edits share the same buffer and serial save queue. */
export async function setDocumentProperties(path: string, properties: Record<string, unknown>, types: Record<string, PropertyKind | null | undefined> = {}): Promise<boolean> {
  return updateDocumentProperties(path, properties, [], undefined, types);
}

export async function removeDocumentProperty(path: string, property: string): Promise<boolean> {
  return updateDocumentProperties(path, {}, [property]);
}

export interface DocumentPropertyState {
  exists: boolean;
  value?: unknown;
}

/** Compare against the latest editor buffer; disk conflicts use the normal save queue. */
export async function compareAndSetDocumentProperty(
  path: string,
  property: string,
  expected: DocumentPropertyState,
  next: DocumentPropertyState,
): Promise<boolean> {
  return compareAndPatchDocumentProperties(path, { [property]: expected }, { [property]: next });
}

/** Check every source/destination key and patch them together in one document write. */
export async function compareAndPatchDocumentProperties(
  path: string,
  expected: Record<string, DocumentPropertyState>,
  next: Record<string, DocumentPropertyState>,
  types: Record<string, PropertyKind | null | undefined> = {},
  forceNonPresetKeys: readonly string[] = [],
): Promise<boolean> {
  const properties = Object.fromEntries(Object.entries(next).filter(([, state]) => state.exists).map(([key, state]) => [key, state.value]));
  const removed = Object.entries(next).filter(([, state]) => !state.exists).map(([key]) => key);
  return updateDocumentProperties(path, properties, removed, expected, types, forceNonPresetKeys);
}

async function updateDocumentProperties(
  path: string,
  properties: Record<string, unknown>,
  removedProperties: string[],
  condition?: Record<string, DocumentPropertyState>,
  types: Record<string, PropertyKind | null | undefined> = {},
  forceNonPresetKeys: readonly string[] = [],
): Promise<boolean> {
  if (!path) return false;
  const file = ensureFileDisplayIdentity(path);
  const release = pinFileDisplayId(file.displayId);
  const identity = documentIdentityFromFile(file);
  try {
    if (!getBuffer(identity)) {
      const content = await memoDocumentOperations.read({ path, scopePath: null });
      if (content === null) return false;
      if (!getBuffer(identity)) applyLoadedContent(identity, path, content, { setAsCurrent: false });
    }
    captureLatestDocumentContent(identity);
    const buffer = getBuffer(identity);
    if (!buffer) return false;
    const currentPath = findFileDisplayPath(file.displayId);
    if (!currentPath) return false;
    if (condition) {
      const match = /^\uFEFF?(?:[ \t]*\r?\n)*---\r?\n((?:[^\r\n]*\r?\n)*?)---(?:\r?\n|$)/.exec(buffer.content);
      const document = parseDocument(match?.[1] ?? '');
      if (document.errors.length || (document.contents && !isMap(document.contents))) return false;
      const values = document.toJS();
      for (const [property, expected] of Object.entries(condition)) {
        if (document.has(property) !== expected.exists) return false;
        if (expected.exists && JSON.stringify(values?.[property]) !== JSON.stringify(expected.value)) return false;
      }
    }
    const previousContent = buffer.content;
    const content = patchDocumentProperties(previousContent, properties, removedProperties, types, forceNonPresetKeys);
    const saved = await saveDocumentContent({ identity, path: currentPath, content });
    if (!saved && condition) {
      captureLatestDocumentContent(identity);
      if (getBuffer(identity)?.content === content) recordDocumentEdit(identity, previousContent);
    }
    return saved;
  } finally {
    release();
  }
}
