import { useCallback, useEffect, useState } from 'react';
import { files, type FileBrowserDirectoriesChangedEvent, type MediaLibraryListItem, type TableDocumentListItem } from '@platform/tauri/client';
import { subscribe } from '@platform/tauri/event-bus';
import { canonicalPath } from '@/lib/path';
import { createLogger } from '@/lib/logger';

const logger = createLogger('notebook-view-data');

interface NotebookViewDataOptions {
  notebookId: string | null;
  notebookPath: string;
  isActive: boolean;
  refreshTrigger: number;
  ignoreCollectionPathEvents: (paths: readonly string[] | undefined) => boolean;
}

/** Owns the table/media catalogs and their snapshot and event updates. */
export function useNotebookViewData({
  notebookId,
  notebookPath,
  isActive,
  refreshTrigger,
  ignoreCollectionPathEvents,
}: NotebookViewDataOptions) {
  const [tableDocuments, setTableDocuments] = useState<TableDocumentListItem[]>([]);
  const [mediaLibraries, setMediaLibraries] = useState<MediaLibraryListItem[]>([]);

  const refreshTables = useCallback(async () => {
    if (notebookId) setTableDocuments(await files.listTableDocuments(notebookId));
  }, [notebookId]);
  const refreshMediaLibraries = useCallback(async () => {
    if (notebookId) setMediaLibraries(await files.listMediaLibraries(notebookId));
  }, [notebookId]);

  useEffect(() => {
    if (!isActive || !notebookId) {
      setTableDocuments([]);
      return;
    }
    let cancelled = false;
    void files.listTableDocuments(notebookId).then((documents) => {
      if (!cancelled) setTableDocuments(documents);
    }).catch((error) => {
      logger.warn('failed to load table documents', { error, notebookId });
      if (!cancelled) setTableDocuments([]);
    });
    return () => { cancelled = true; };
  }, [isActive, notebookId, refreshTrigger]);
  useEffect(() => {
    if (!isActive || !notebookId) {
      setMediaLibraries([]);
      return;
    }
    let cancelled = false;
    void files.listMediaLibraries(notebookId).then((libraries) => {
      if (!cancelled) setMediaLibraries(libraries);
    }).catch((error) => {
      logger.warn('failed to load media libraries', { error, notebookId });
      if (!cancelled) setMediaLibraries([]);
    });
    return () => { cancelled = true; };
  }, [isActive, notebookId, refreshTrigger]);
  useEffect(() => {
    const applied = new Map<string, number>();
    return subscribe<{ notebookId: string; collectionId: string; relativePath: string; name: string; revision: number; indexSequence: number }>('collection-changed', (event) => {
      if (event.notebookId !== notebookId || event.indexSequence < (applied.get(event.collectionId) ?? -1)) return;
      applied.set(event.collectionId, event.indexSequence);
      setTableDocuments((items) => items.map((item) => item.collectionId === event.collectionId ? { ...item, relativePath: event.relativePath, name: event.name, fileRevision: event.revision } : item));
      setMediaLibraries((items) => items.map((item) => item.collectionId === event.collectionId ? { ...item, relativePath: event.relativePath, name: event.name } : item));
    });
  }, [notebookId]);
  useEffect(() => subscribe<{ notebookId: string }>('file-management-changed', (event) => {
    if (event.notebookId !== notebookId || !notebookId) return;
    void refreshTables().catch((error) => {
      logger.warn('failed to refresh table documents', { error, notebookId });
    });
    void refreshMediaLibraries().catch((error) => {
      logger.warn('failed to refresh media libraries', { error, notebookId });
    });
  }), [notebookId, refreshTables, refreshMediaLibraries]);

  useEffect(() => subscribe<FileBrowserDirectoriesChangedEvent>(
    'file-browser-directories-changed',
    (event) => {
      if (!notebookId || canonicalPath(event.rootPath) !== canonicalPath(notebookPath)) return;
      if (ignoreCollectionPathEvents(event.paths)) return;
      void refreshTables().catch((error) => {
        logger.warn('failed to refresh table documents after file change', { error, notebookId });
      });
      void refreshMediaLibraries().catch((error) => {
        logger.warn('failed to refresh media libraries after file change', { error, notebookId });
      });
    },
  ), [notebookId, notebookPath, ignoreCollectionPathEvents, refreshTables, refreshMediaLibraries]);

  const updateTableIdentity = useCallback((relativePath: string, collectionId: string) => {
    setTableDocuments((current) => current.map((table) => table.relativePath === relativePath
      ? { ...table, collectionId, inViews: false, identityConflict: false }
      : table));
  }, []);
  const updateMediaLibraryIdentity = useCallback((relativePath: string, collectionId: string) => {
    setMediaLibraries((current) => current.map((library) => library.relativePath === relativePath
      ? { ...library, collectionId, inViews: false, identityConflict: false }
      : library));
  }, []);

  return {
    tableDocuments,
    mediaLibraries,
    refreshTables,
    refreshMediaLibraries,
    updateTableIdentity,
    updateMediaLibraryIdentity,
  };
}
