import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { dialogs, mediaResources, type DocumentPageItem } from '@platform/tauri/client';
import { resourceKindFromPath } from '@features/editor/public/code-file';
import { canonicalDirectoryPath, canonicalPath, joinNotebookMemoPath, parentDirectoryPath, notebookRelativeDirectoryPath } from '@/lib/path';
import { toast } from '@/lib/toast';
import type { useI18n } from '@/lib/i18n';
import { mediaLibraryFileCondition, parseMediaLibrary, type MediaLibraryDocument, createMediaLibraryRecord } from './model';
import { resolveMediaLibraryAddDirectories } from './add-location';
import { saveMediaFile } from './media-import';

type PersistMutation = (
  mutate: (current: MediaLibraryDocument) => MediaLibraryDocument,
  targetPath?: string,
  lockAlreadyHeld?: boolean,
  initialDocument?: MediaLibraryDocument,
) => Promise<boolean>;

interface MediaLibraryActionsOptions {
  document: MediaLibraryDocument | null;
  setDocument: Dispatch<SetStateAction<MediaLibraryDocument | null>>;
  notebookPath: string | null;
  notebookId: string | null;
  currentFilePath: string;
  saving: boolean;
  setSaving: Dispatch<SetStateAction<boolean>>;
  sourceContentRef: MutableRefObject<string | null>;
  saveInFlightRef: MutableRefObject<boolean>;
  persistMutation: PersistMutation;
  t: ReturnType<typeof useI18n>['t'];
}

export function useMediaLibraryActions({
  document, setDocument, notebookPath, notebookId, currentFilePath, saving, setSaving,
  sourceContentRef, saveInFlightRef, persistMutation, t,
}: MediaLibraryActionsOptions) {
  const addMedia = useCallback(async (): Promise<boolean> => {
    if (!document || !notebookPath || !notebookId || saving || saveInFlightRef.current) return false;
    const selectedPaths = await dialogs.selectFiles({ accept: 'image/*', multiple: true });
    if (!selectedPaths?.length) return false;
    if (saveInFlightRef.current) {
      toast.error(t('mediaLibrary.addMediaWaitForSave'));
      return false;
    }
    const latestDocument = sourceContentRef.current ? parseMediaLibrary(sourceContentRef.current) : document;
    const validPaths = selectedPaths.filter((path) => {
      const kind = resourceKindFromPath(path);
      return kind === 'image';
    });
    if (!validPaths.length) {
      toast.error(t('mediaLibrary.addMediaNoSupported'));
      return false;
    }
    const rejected = selectedPaths.length - validPaths.length;
    const root = canonicalDirectoryPath(notebookPath);
    let targetDirectories: Array<string | null>;
    try {
      targetDirectories = resolveMediaLibraryAddDirectories(
        currentFilePath,
        notebookPath,
        mediaLibraryFileCondition(latestDocument).path_contains,
      );
      const source = latestDocument.dataset.source;
      if (source && source.scope !== 'notebook') {
        const scopedFolder = source.scope === 'folder'
          ? joinNotebookMemoPath(root, source.path ?? '')
          : parentDirectoryPath(currentFilePath, root);
        if (!scopedFolder) throw new Error('集合范围目录无效');
        const scopedRelativePath = notebookRelativeDirectoryPath(root, scopedFolder)?.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        if (!scopedRelativePath) {
          targetDirectories = [root];
        } else {
          const scopedPrefix = `${scopedRelativePath}/`;
          targetDirectories = targetDirectories.filter((path): path is string => {
            if (!path) return false;
            const relative = notebookRelativeDirectoryPath(root, path)?.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
            if (relative === scopedRelativePath) return true;
            return source.depth === 'descendants' && Boolean(relative?.startsWith(scopedPrefix));
          });
          if (!targetDirectories.some((path) => path !== null && canonicalPath(path) === canonicalPath(scopedFolder))) targetDirectories.push(scopedFolder);
        }
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('mediaLibrary.addMediaFailed'));
      return false;
    }
    const recordsToAppend = [] as ReturnType<typeof createMediaLibraryRecord>[];
    const importedPaths: string[] = [];
    const pathsToRollback: string[] = [];
    const completed: string[] = [];
    let failed = 0;
    saveInFlightRef.current = true;
    setSaving(true);
    try {
      for (const sourcePath of validPaths) {
        try {
          const saved = await saveMediaFile(sourcePath, notebookId, targetDirectories);
          const importedPath = saved.path;
          const canonicalImported = canonicalPath(importedPath);
          if (!canonicalImported.startsWith(`${root}/`)) throw new Error('导入媒体路径不在当前笔记本');
          const relativePath = canonicalImported.slice(root.length + 1).replace(/\\/g, '/');
          const indexedResource = await mediaResources.get(importedPath, notebookPath).catch(() => null);
          recordsToAppend.push(createMediaLibraryRecord(relativePath, indexedResource?.resource.id));
          importedPaths.push(canonicalImported);
          if (saved.created) pathsToRollback.push(canonicalImported);
          completed.push(importedPath);
          // Ensure the media index knows about each imported or reused image.
        } catch (error) {
          console.error('[MediaLibrary] Failed to save image:', error);
          failed += 1;
        }
      }
      if (recordsToAppend.length) {
        const saved = await persistMutation((current) => {
          const linked = new Set(current.dataset.records.include.map((record) => canonicalPath(record.relative_path).toLocaleLowerCase()));
          const additions = recordsToAppend.filter((record) => {
            const key = canonicalPath(record.relative_path).toLocaleLowerCase();
            if (linked.has(key)) return false;
            linked.add(key);
            return true;
          });
          return {
            ...current,
            collection: { ...current.collection, revision: current.collection.revision + 1, updated_at: new Date().toISOString() },
            dataset: { ...current.dataset, records: { ...current.dataset.records, include: [...current.dataset.records.include, ...additions] } },
          };
        }, currentFilePath, true, latestDocument);
        if (!saved) {
          // A conflicting external update may already have linked one of these
          // imported paths. Keep linked files and roll back only new files that
          // remain unreferenced in the latest document.
          let latestRecords = latestDocument.dataset.records.include;
          try {
            if (sourceContentRef.current) latestRecords = parseMediaLibrary(sourceContentRef.current).dataset.records.include;
          } catch { /* Fall back to the document snapshot captured before import. */ }
          const linkedPaths = new Set(latestRecords.flatMap((record) => {
            const path = joinNotebookMemoPath(notebookPath, record.relative_path);
            return path ? [canonicalPath(path).toLocaleLowerCase()] : [];
          }));
          const importedPathKeys = new Set(importedPaths.map((path) => canonicalPath(path).toLocaleLowerCase()));
          const rollbackPaths = pathsToRollback.filter((path) => !linkedPaths.has(canonicalPath(path).toLocaleLowerCase()));
          const rollbackResults = await Promise.all(rollbackPaths.map(async (path) => {
            try { return await mediaResources.delete(path, notebookPath); } catch { return false; }
          }));
          const rollbackFailedCount = rollbackResults.filter((deleted) => !deleted).length;
          // Keep an imported item in the result only if it was linked after the
          // failed save.
          completed.splice(0, completed.length, ...completed.filter((path) => {
            const key = canonicalPath(path).toLocaleLowerCase();
            return !importedPathKeys.has(key) || linkedPaths.has(key);
          }));
          toast.error(rollbackFailedCount
            ? t('mediaLibrary.addMediaCleanupFailed', { count: rollbackFailedCount })
            : t('mediaLibrary.addMediaRecordFailed'));
        }
      }
      if (rejected) toast.error(t('mediaLibrary.addMediaSkipped', { count: rejected }));
      if (failed) toast.error(t('mediaLibrary.addMediaImportFailed', { count: failed }));
      if (completed.length) toast.success(t('mediaLibrary.addMediaSuccess', { count: completed.length }));
      if (!completed.length && !failed) toast.error(t('mediaLibrary.addMediaFailed'));
      return completed.length > 0;
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  }, [currentFilePath, document, notebookId, notebookPath, persistMutation, saving, t]);

  const deleteMedia = useCallback(async (item: DocumentPageItem): Promise<boolean> => {
    if (!document || !notebookPath || saving || saveInFlightRef.current) return false;
    const root = canonicalDirectoryPath(notebookPath);
    const filePath = canonicalPath(item.fullPath);
    const rootPrefix = root === '/' ? '/' : `${root}/`;
    if (!filePath.startsWith(rootPrefix)) return false;
    const relativePath = filePath.slice(rootPrefix.length).replace(/\\/g, '/');
    const latestDocument = sourceContentRef.current ? parseMediaLibrary(sourceContentRef.current) : document;
    const hasLibraryRecord = latestDocument.dataset.records.include.some((record) => record.relative_path.toLocaleLowerCase() === relativePath.toLocaleLowerCase());

    saveInFlightRef.current = true;
    setSaving(true);
    try {
      const deleted = await mediaResources.delete(filePath, notebookPath);
      if (!deleted) {
        toast.error(t('media.fileTree.deleteFailed'));
        return false;
      }
      if (hasLibraryRecord) {
        const removeRecord = (current: MediaLibraryDocument): MediaLibraryDocument => ({
          ...current,
          collection: { ...current.collection, revision: current.collection.revision + 1, updated_at: new Date().toISOString() },
          dataset: { ...current.dataset, records: { ...current.dataset.records,
            include: current.dataset.records.include.filter((record) => record.relative_path.toLocaleLowerCase() !== relativePath.toLocaleLowerCase()),
          } },
        });
        const saved = await persistMutation(removeRecord, currentFilePath, true, latestDocument);
        if (!saved) {
          const latest = sourceContentRef.current ? parseMediaLibrary(sourceContentRef.current) : latestDocument;
          setDocument(removeRecord(latest));
        }
      }
      toast.success(t('media.fileTree.deleted', { name: item.name }));
      return true;
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : t('media.fileTree.deleteFailed'));
      return false;
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  }, [currentFilePath, document, notebookPath, persistMutation, saving, t]);

  return { addMedia, deleteMedia };
}
