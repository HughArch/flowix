import { createCollectionMetadata, createUuidV7, parseCollectionDocumentV2, serializeCollectionDocumentV2, type CollectionMetadata, type CollectionSource } from '@features/collection/model';
import { createUniqueNotebookFile } from '@features/collection/create-unique-notebook-file';
export { createUuidV7 } from '@features/collection/model';
import { sanitizeFileName } from '@/lib/export-utils';
import { matchesDatasetFilter, type DatasetFilter } from '@features/collection/rule-filter';
import { resolveDatasetFilterForLocation } from '@features/collection/dataset-filter-location';

export type MediaLibraryKind = 'image' | 'video';
export interface MediaLibraryFileCondition {
  file_name_contains?: string;
  file_type?: MediaLibraryKind;
  path_contains?: string;
  path_scope?: 'all';
}

export interface MediaLibraryRecord {
  id: string;
  updated_at: string;
  resource_id: string;
  /** Notebook-relative path to an explicitly linked media file. */
  relative_path: string;
}

/** Empty filter containers do not opt a standalone media library into notebook-wide browsing. */
export function hasMediaDatasetFilter(filter: Record<string, unknown> | null | undefined): boolean {
  if (!filter) return false;
  if (Array.isArray(filter.conditions) && (filter.match === 'all' || filter.match === 'any')) {
    return typeof filter.path === 'string' || filter.conditions.length > 0;
  }
  const all = Array.isArray(filter.all) ? filter.all : [];
  const any = Array.isArray(filter.any) ? filter.any : [];
  return all.length > 0 || any.length > 0;
}

export function normalizeMediaLibraryFileCondition(condition?: MediaLibraryFileCondition | null): MediaLibraryFileCondition {
  const normalized = {
    file_name_contains: condition?.file_name_contains?.trim() ?? '',
    file_type: condition?.file_type ?? '',
    path_contains: condition?.path_contains?.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') ?? '',
    path_scope: condition?.path_scope === 'all' ? 'all' : '',
  };
  return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value)) as MediaLibraryFileCondition;
}

export function mediaCollectionFilterFromCondition(condition?: MediaLibraryFileCondition | null): Record<string, unknown> {
  const normalized = normalizeMediaLibraryFileCondition(condition);
  const conditions: Record<string, unknown>[] = [];
  if (normalized.file_name_contains) conditions.push({ field: 'file_name', op: 'contains', value: normalized.file_name_contains });
  if (normalized.file_type) conditions.push({ field: 'kind', op: 'eq', value: normalized.file_type });
  return {
    path: normalized.path_scope === 'all' ? '' : normalized.path_contains || null,
    match: 'all',
    conditions,
  };
}

export function matchesMediaCollectionFilter(relativePath: string, kind: MediaLibraryKind, filter?: Record<string, unknown> | null): boolean {
  if (!filter) return true;
  const path = relativePath.replace(/\\/g, '/');
  const name = path.split('/').pop() ?? path;
  const directory = path.split('/').slice(0, -1).join('/');
  return matchesDatasetFilter(filter as unknown as DatasetFilter, (rule) => {
    const actual = rule.field === 'file_name' ? name : rule.field === 'path' ? directory : rule.field === 'kind' ? kind : undefined;
    if (actual === undefined) return false;
    if (rule.op === 'in' && Array.isArray(rule.value)) return rule.value.some((value) => String(value).toLocaleLowerCase() === actual.toLocaleLowerCase());
    if ((rule.op === 'eq' || rule.op === 'equals') && rule.value != null) return actual.toLocaleLowerCase() === String(rule.value).toLocaleLowerCase();
    if (rule.op !== 'contains' || typeof rule.value !== 'string') return false;
    const expected = rule.value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLocaleLowerCase();
    const value = actual.toLocaleLowerCase();
    if (rule.field === 'path' && expected === '') return true;
    return rule.field === 'path' ? value === expected || value.startsWith(`${expected}/`) : value.includes(expected);
  });
}

export interface MediaLibraryDocument {
  collection: CollectionMetadata;
  dataset: {
    source: CollectionSource;
    schema: { fields: [] };
    records: { include: MediaLibraryRecord[]; exclude: Array<{ relative_path: string }> };
    filter: Record<string, unknown> | null;
  };
  views: {
    default_id: string;
    items: Array<{
      id: string;
      name: string;
      layout: 'waterfall';
      filter: Record<string, unknown>;
      sort: Array<{ field: 'created_at'; direction: 'desc' }>;
      config: Record<string, unknown>;
    }>;
  };
}

export function mediaLibraryDefaultView(document: MediaLibraryDocument) {
  return document.views.items.find((view) => view.id === document.views.default_id)!;
}

export function mediaLibraryFileCondition(document: MediaLibraryDocument): MediaLibraryFileCondition {
  const filter = document.dataset.filter;
  if (!filter) return {};
  const condition: MediaLibraryFileCondition = {};
  let rules: unknown[];
  if (Array.isArray(filter.conditions) && (filter.match === 'all' || filter.match === 'any')) {
    rules = filter.conditions;
    if (filter.path === '') condition.path_scope = 'all';
    else if (typeof filter.path === 'string') condition.path_contains = filter.path;
  } else if (Array.isArray(filter.all) && Array.isArray(filter.any)) {
    const anyNonPath = filter.any.filter((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry) || entry.field !== 'path');
    if (anyNonPath.length) return {};
    rules = [...filter.all, ...filter.any];
  } else {
    return {};
  }
  const pathRules = rules.filter((entry) => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)
    && (entry as Record<string, unknown>).field === 'path')) as Record<string, unknown>[];
  if (pathRules.length) {
    const nonEmptyPaths = pathRules.map((rule) => typeof rule.value === 'string' ? rule.value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') : '').filter(Boolean);
    condition.path_scope = nonEmptyPaths.length ? undefined : 'all';
    if (nonEmptyPaths.length) condition.path_contains = nonEmptyPaths.sort((left, right) => right.length - left.length)[0];
  }
  for (const entry of rules) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const rule = entry as Record<string, unknown>;
    if (rule.field === 'file_name' && rule.op === 'contains' && typeof rule.value === 'string') condition.file_name_contains = rule.value;
    if (rule.field === 'kind' && rule.op === 'eq' && (rule.value === 'image' || rule.value === 'video')) condition.file_type = rule.value;
  }
  return condition;
}

export function canEditMediaLibraryFilter(document: MediaLibraryDocument): boolean {
  const filter = document.dataset.filter;
  if (!filter) return true;
  if (Array.isArray(filter.conditions) && filter.match === 'all') {
    const conditions = filter.conditions as Record<string, unknown>[];
    const fields = conditions.map((rule) => rule.field);
    return new Set(fields).size === fields.length && conditions.every((rule) => (
      (rule.field === 'file_name' && rule.op === 'contains' && typeof rule.value === 'string')
      || (rule.field === 'kind' && rule.op === 'eq' && (rule.value === 'image' || rule.value === 'video'))
      || (rule.field === 'kind' && rule.op === 'in' && Array.isArray(rule.value)
        && rule.value.length === 2 && rule.value.includes('image') && rule.value.includes('video'))
    ));
  }
  const all = Array.isArray(filter.all) ? filter.all as Record<string, unknown>[] : null;
  const any = Array.isArray(filter.any) ? filter.any as Record<string, unknown>[] : null;
  // The compact media editor represents conjunctions and one value per field.
  // OR branches or duplicate scalar rules cannot be written back losslessly.
  if (!all || !any || any.length > 0) return false;
  const rules = all;
  const pathRules = rules.filter((rule) => rule.field === 'path');
  const scalarRules = rules.filter((rule) => rule.field !== 'path');
  if (new Set(scalarRules.map((rule) => rule.field)).size !== scalarRules.length) return false;
  const paths = [...new Set(pathRules.map((rule) => typeof rule.value === 'string'
    ? rule.value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') : null))];
  if (pathRules.some((rule) => rule.op !== 'contains' || typeof rule.value !== 'string')
    || paths.includes(null)) return false;
  const nonEmptyPaths = paths.filter((path): path is string => Boolean(path));
  if (nonEmptyPaths.some((path) => nonEmptyPaths.some((other) => path !== other
    && !path.startsWith(`${other}/`) && !other.startsWith(`${path}/`)))) return false;
  return rules.every((rule) => (
    (rule.field === 'path' && rule.op === 'contains' && typeof rule.value === 'string')
    || (rule.field === 'file_name' && rule.op === 'contains' && typeof rule.value === 'string')
    || (rule.field === 'kind' && rule.op === 'eq' && (rule.value === 'image' || rule.value === 'video'))
    || (rule.field === 'kind' && rule.op === 'in' && Array.isArray(rule.value)
      && rule.value.length === 2 && rule.value.includes('image') && rule.value.includes('video'))
  ));
}

export function createMediaLibraryRecord(notebookId: string, relativePath: string, resourceId?: string, now = new Date().toISOString()): MediaLibraryRecord {
  const path = relativePath.replace(/\\/g, '/');
  return { id: `rec_${createUuidV7()}`, updated_at: now, resource_id: resourceId ?? `${notebookId}::${path}`, relative_path: path };
}

/** Called against each current document, including conflict retries. */
export function mediaCollectionFilterForSave(document: MediaLibraryDocument, condition: MediaLibraryFileCondition, filePath: string, notebookPath: string): Record<string, unknown> | null {
  if (!canEditMediaLibraryFilter(document)) throw new Error('当前媒体库包含编辑器不支持的筛选，已取消保存');
  const normalized = normalizeMediaLibraryFileCondition(condition);
  const filter = document.collection.placement === 'folder' || Object.keys(normalized).length
    ? mediaCollectionFilterFromCondition(normalized) : null;
  return resolveDatasetFilterForLocation(filter, document.collection.placement, filePath, notebookPath);
}

export function createMediaLibrary(name: string): MediaLibraryDocument {
  const viewId = `view_${createUuidV7()}`;
  return {
    collection: createCollectionMetadata('media_library', name),
    dataset: {
      source: { scope: 'notebook', depth: 'descendants' },
      schema: { fields: [] }, records: { include: [], exclude: [] },
      filter: null,
    },
    views: { default_id: viewId, items: [{ id: viewId, name: '媒体库', layout: 'waterfall',
      filter: { all: [], any: [] }, sort: [{ field: 'created_at', direction: 'desc' }], config: {} }] },
  };
}

export function serializeMediaLibrary(document: MediaLibraryDocument): string {
  return serializeCollectionDocumentV2({ format: 'flowix.collection', schema_version: 2,
    collection: document.collection, payload: { schema_version: 2, dataset: document.dataset, views: document.views } });
}

export function parseMediaLibrary(source: string): MediaLibraryDocument {
  const document = parseCollectionDocumentV2(source, 'media_library');
  return { collection: document.collection, dataset: document.payload.dataset as unknown as MediaLibraryDocument['dataset'],
    views: document.payload.views as unknown as MediaLibraryDocument['views'] };
}

export function validateMediaLibraryDocument(value: unknown): MediaLibraryDocument {
  if (!value || typeof value !== 'object') throw new Error('媒体库文档无效');
  const document = value as MediaLibraryDocument;
  serializeMediaLibrary(document);
  return document;
}

export async function createMediaLibraryFile(
  notebookPath: string,
  relativeFolder: string | null | undefined,
  name: string,
): Promise<{ filePath: string; document: MediaLibraryDocument }> {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error('请输入媒体库名称');
  const stem = sanitizeFileName(trimmedName).replace(/(?:\.lib\.ya?ml|\.index\.yaml)$/i, '');
  if (!stem) throw new Error('媒体库名称无效');
  const document = createMediaLibrary(stem);
  const { filePath } = await createUniqueNotebookFile(
    notebookPath,
    relativeFolder,
    stem,
    '.index.yaml',
    serializeMediaLibrary(document),
  );
  return { filePath, document };
}
