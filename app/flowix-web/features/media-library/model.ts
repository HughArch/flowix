import { createCollectionMetadata, createUuidV7, parseCollectionDocumentV2, serializeCollectionDocumentV2, type CollectionMetadata, type CollectionSource } from '@features/collection/model';
import { createUniqueNotebookFile } from '@features/collection/create-unique-notebook-file';
export { createUuidV7 } from '@features/collection/model';
import { sanitizeFileName } from '@/lib/export-utils';
import { matchesCollectionFilter, type CollectionRuleFilter } from '@features/collection/rule-filter';

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
  const all: Record<string, unknown>[] = [];
  if (normalized.file_name_contains) all.push({ field: 'file_name', op: 'contains', value: normalized.file_name_contains });
  if (normalized.path_scope === 'all') all.push({ field: 'path', op: 'contains', value: '' });
  else if (normalized.path_contains) all.push({ field: 'path', op: 'contains', value: normalized.path_contains });
  if (normalized.file_type) all.push({ field: 'kind', op: 'eq', value: normalized.file_type });
  return { all, any: [] };
}

export function matchesMediaCollectionFilter(relativePath: string, kind: MediaLibraryKind, filter?: Record<string, unknown> | null): boolean {
  if (!filter) return true;
  const path = relativePath.replace(/\\/g, '/');
  const name = path.split('/').pop() ?? path;
  const directory = path.split('/').slice(0, -1).join('/');
  return matchesCollectionFilter(filter as unknown as CollectionRuleFilter, (rule) => {
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
  if (!filter || !Array.isArray(filter.all) || (Array.isArray(filter.any) && filter.any.length)) return {};
  const condition: MediaLibraryFileCondition = {};
  for (const entry of filter.all) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    if (entry.field === 'file_name' && entry.op === 'contains' && typeof entry.value === 'string') condition.file_name_contains = entry.value;
    if (entry.field === 'path' && entry.op === 'contains' && typeof entry.value === 'string') {
      if (entry.value === '') condition.path_scope = 'all';
      else condition.path_contains = entry.value;
    }
    if (entry.field === 'kind' && entry.op === 'eq' && (entry.value === 'image' || entry.value === 'video')) condition.file_type = entry.value;
  }
  return condition;
}

export function createMediaLibraryRecord(relativePath: string, resourceId?: string, now = new Date().toISOString()): MediaLibraryRecord {
  const path = relativePath.replace(/\\/g, '/');
  return { id: `rec_${createUuidV7()}`, updated_at: now, resource_id: resourceId ?? `path:${path}`, relative_path: path };
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
