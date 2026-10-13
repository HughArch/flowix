import { mediaResources, notebookAssets } from '@platform/tauri/client';
import { canonicalDirectoryPath, canonicalPath, joinNotebookMemoPath } from '@/lib/path';
import { resolveMediaLibraryAddDirectory } from './add-location';
import { createMediaLibraryRecord, type MediaLibraryDocument, type MediaLibraryRecord } from './model';

export interface MediaImportResult {
  completed: string[];
  failed: number;
  recordSaveFailed: boolean;
  cleanupFailed: number;
}

const pathKey = (path: string) => canonicalPath(path).toLocaleLowerCase();

/** Both library surfaces share import, record deduplication and rollback; each supplies its save adapter. */
export async function importMediaLibraryFiles({ paths, notebookId, notebookPath, filePath, document, persist, readLatest }: {
  paths: string[];
  notebookId: string;
  notebookPath: string;
  filePath: string;
  document: MediaLibraryDocument;
  persist: (mutate: (current: MediaLibraryDocument) => MediaLibraryDocument) => Promise<boolean>;
  readLatest: () => Promise<MediaLibraryDocument | null>;
}): Promise<MediaImportResult> {
  const destination = resolveMediaLibraryAddDirectory({ filePath, notebookPath, document });
  const root = canonicalDirectoryPath(notebookPath);
  const destinationKey = pathKey(destination ?? `${root.replace(/\/$/, '')}/attachments`);
  const rootPrefix = root === '/' ? '/' : `${root}/`;
  const imported = new Map<string, { path: string; created: boolean; record: MediaLibraryRecord }>();
  const result: MediaImportResult = { completed: [], failed: 0, recordSaveFailed: false, cleanupFailed: 0 };

  for (const sourcePath of paths) {
    try {
      const saved = await notebookAssets.saveFromPath(sourcePath, {
        notebookId, ...(destination ? { targetDirectoryPath: destination } : {}), deduplicate: true,
        reuseNotebookFile: false, reuseExistingAttachment: false,
      });
      if (!saved?.path) throw new Error('Media save returned no path');
      const path = canonicalPath(saved.path);
      if (!path.startsWith(rootPrefix)) throw new Error('导入媒体路径不在当前笔记本');
      const resource = await mediaResources.get(path, notebookPath).catch(() => null);
      const key = pathKey(path);
      const previous = imported.get(key);
      imported.set(key, {
        path, created: saved.created || previous?.created === true,
        record: previous?.record ?? createMediaLibraryRecord(path.slice(rootPrefix.length), resource?.resource.id),
      });
    } catch (error) {
      console.error('[MediaLibrary] Failed to import media:', error);
      result.failed += 1;
    }
  }
  if (!imported.size) return result;

  let saved = false;
  try {
    saved = await persist((current) => {
      if (current.collection.id !== document.collection.id
        || pathKey(resolveMediaLibraryAddDirectory({ filePath, notebookPath, document: current }) ?? `${root.replace(/\/$/, '')}/attachments`) !== destinationKey) {
        throw new Error('媒体库上传目录或身份已变化，请重试');
      }
      const linked = new Set(current.dataset.records.include.map((record) => pathKey(record.relative_path)));
      const additions = [...imported.values()].flatMap(({ record }) => {
        const key = pathKey(record.relative_path);
        if (linked.has(key)) return [];
        linked.add(key);
        return [record];
      });
      return {
        ...current,
        collection: { ...current.collection, revision: current.collection.revision + 1, updated_at: new Date().toISOString() },
        dataset: { ...current.dataset, records: { ...current.dataset.records, include: [...current.dataset.records.include, ...additions] } },
      };
    });
  } catch (error) {
    console.error('[MediaLibrary] Failed to save imported records:', error);
  }
  if (saved) {
    result.completed = [...imported.values()].map(({ path }) => path);
    return result;
  }

  result.recordSaveFailed = true;
  const latest = await readLatest().catch(() => null);
  // If the latest file cannot be read, preserve copies rather than delete possibly linked assets.
  const linked = latest ? new Set(latest.dataset.records.include.flatMap((record) => {
    const path = joinNotebookMemoPath(root, record.relative_path);
    return path ? [pathKey(path)] : [];
  })) : null;
  for (const [key, item] of imported) {
    if (linked?.has(key)) {
      result.completed.push(item.path);
    } else if (item.created) {
      const deleted = linked ? await mediaResources.delete(item.path, notebookPath).catch(() => false) : false;
      if (!deleted) result.cleanupFailed += 1;
    }
  }
  return result;
}
