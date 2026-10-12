import { useCallback, useEffect, useRef, useState } from 'react';
import { files, mediaResources, type DocumentPage, type DocumentPageItem, type FileBrowserDirectoriesChangedEvent, type MediaResourcePage } from '@platform/tauri/client';
import { subscribe } from '@platform/tauri/event-bus';
import { canonicalPath, joinNotebookMemoPath } from '@/lib/path';
import { createLogger } from '@/lib/logger';
import type { MediaLibraryRecord } from '@features/media-library/model';
import type { DocumentListSurface } from './types';

const logger = createLogger('document-list-data');
const MEDIA_LIBRARY_PAGE_SIZE = 30;

async function loadLinkedMediaItems(
  records: MediaLibraryRecord[],
  notebookPath: string,
  onBatch: (items: DocumentPageItem[]) => void,
  shouldStop: () => boolean,
): Promise<void> {
  // Keep record resolution bounded when a library links many local attachments.
  for (let offset = 0; offset < records.length; offset += 8) {
    if (shouldStop()) return;
    const batch = records.slice(offset, offset + 8);
    const resolved = await Promise.all(batch.map(async (record) => {
      const filePath = joinNotebookMemoPath(notebookPath, record.relative_path);
      if (!filePath) return null;
      try {
        const { resource } = await mediaResources.get(filePath, notebookPath);
        return mediaResourceListItem(resource, notebookPath);
      } catch { return null; }
    }));
    const items = resolved.filter((item): item is DocumentPageItem => item !== null);
    if (shouldStop()) return;
    if (items.length) onBatch(items);
  }
}

function mediaResourceListItem(resource: { relativePath: string; kind: 'image' | 'video'; sizeBytes: number; modifiedMs: number; createdAt: number }, notebookPath: string): DocumentPageItem | null {
  const fullPath = joinNotebookMemoPath(notebookPath, resource.relativePath);
  if (!fullPath) return null;
  return {
    fullPath,
    name: resource.relativePath.split(/[\\/]/).filter(Boolean).pop() ?? resource.relativePath,
    resourceKind: resource.kind,
    sizeBytes: resource.sizeBytes,
    modifiedMs: resource.modifiedMs,
    createdMs: resource.createdAt,
  };
}

/** Owns paging, cancellation and coalesced refreshes; UI action permissions are separate. */
export function useDocumentListData({ surface, mediaLibrary, mediaLibraryRecords, refreshPaused }: {
  surface: DocumentListSurface;
  mediaLibrary: boolean;
  mediaLibraryRecords: MediaLibraryRecord[];
  refreshPaused: boolean;
}) {
  const resourceKindsKey = (surface.filters.resourceKinds ?? []).join('\u0000');
  const hasMediaDataset = Boolean(surface.mediaScope || surface.mediaDatasetActive);
  const hasLinkedMedia = mediaLibraryRecords.length > 0;
  const [items, setItems] = useState<DocumentPageItem[]>([]);
  const [linkedItems, setLinkedItems] = useState<DocumentPageItem[]>([]);
  const [folders, setFolders] = useState<DocumentPageItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingLinkedItems, setLoadingLinkedItems] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const loadingRef = useRef(false);
  const pendingRefreshRef = useRef(false);
  const requestGenerationRef = useRef(0);
  const loadedListIdentityRef = useRef<string | null>(null);
  const refreshPausedRef = useRef(false);
  refreshPausedRef.current = refreshPaused;
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const requestRefresh = useCallback(() => {
    if (loadingRef.current || refreshPausedRef.current) {
      pendingRefreshRef.current = true;
      return;
    }
    setRevision((value) => value + 1);
  }, []);
  useEffect(() => subscribe<{ notebookId: string }>('file-management-changed', ({ notebookId }) => {
    if (notebookId === surface.notebookId) requestRefresh();
  }), [requestRefresh, surface.notebookId]);
  useEffect(() => subscribe<{ notebookId: string }>('media-properties-changed', ({ notebookId }) => {
    if (notebookId === surface.notebookId) requestRefresh();
  }), [requestRefresh, surface.notebookId]);
  useEffect(() => subscribe<FileBrowserDirectoriesChangedEvent>(
    'file-browser-directories-changed',
    (event) => {
      if (canonicalPath(event.rootPath) !== canonicalPath(surface.notebookPath)) return;
      const changedPaths = event.paths ?? [];
      // Library-config mutations update the catalog separately, but do not change the media rows shown here.
      if (mediaLibrary && changedPaths.length > 0 && changedPaths.every((path) => /\.lib\.ya?ml$/i.test(path))) return;
      const root = canonicalPath(surface.notebookPath).replace(/\/$/, '');
      const directories = event.directories.filter((directory) => {
        const path = canonicalPath(directory);
        if (path === root) return true;
        return path.startsWith(`${root}/`);
      });
      if (directories.length === 0) return;
      requestRefresh();
    },
  ), [mediaLibrary, requestRefresh, surface.notebookPath]);
  useEffect(() => {
    if (refreshPaused) {
      loadingRef.current = false;
      pendingRefreshRef.current = true;
      return;
    }
    pendingRefreshRef.current = false;
    const generation = ++requestGenerationRef.current;
    let cancelled = false;
    if (!surface.notebookId) {
      loadingRef.current = false;
      setItems([]);
      setError(true);
      setLoading(false);
      setLoadingLinkedItems(false);
      return;
    }
    if (mediaLibrary && !hasMediaDataset && !hasLinkedMedia) {
      loadingRef.current = false;
      setLoading(false);
      setLoadingMore(false);
      setMoreError(false);
      setError(false);
      setItems([]);
      setLinkedItems([]);
      setLoadingLinkedItems(false);
      setFolders([]);
      setHasMore(false);
      setNextCursor(null);
      return () => { cancelled = true; requestGenerationRef.current += 1; };
    }
    loadingRef.current = true;
    setLoading(true);
    setLoadingLinkedItems(mediaLibrary && hasLinkedMedia);
    setLoadingMore(false);
    setMoreError(false);
    setError(false);
    const listIdentity = JSON.stringify([surface.displayId, surface.notebookPath, mediaLibrary]);
    if (loadedListIdentityRef.current !== listIdentity) {
      setItems([]);
      setLinkedItems([]);
      setFolders([]);
    }
    loadedListIdentityRef.current = listIdentity;
    setHasMore(false);
    setNextCursor(null);
    const pageRequest = mediaLibrary
      ? hasMediaDataset
        ? mediaResources.listPage(surface.notebookPath, (surface.filters.resourceKinds ?? ['image', 'video']).filter((kind): kind is 'image' | 'video' => kind === 'image' || kind === 'video'), null, MEDIA_LIBRARY_PAGE_SIZE, surface.mediaScope?.relativePath ?? null, surface.mediaScope?.depth)
        : Promise.resolve({ resources: [], nextCursor: null, hasMore: false } satisfies MediaResourcePage)
      : files.listDocumentPage({ notebookId: surface.notebookId, folderPath: surface.folderPath, resourceKinds: surface.filters.resourceKinds });
    const nextLinkedItems: DocumentPageItem[] = [];
    const linkedRequest = mediaLibrary
      ? loadLinkedMediaItems(mediaLibraryRecords, surface.notebookPath, (batch) => {
        if (cancelled || generation !== requestGenerationRef.current) return;
        nextLinkedItems.push(...batch);
        setLinkedItems([...nextLinkedItems]);
        // Libraries that only contain explicit records can render as soon as
        // their first bounded batch resolves, while later batches continue.
        if (!hasMediaDataset) setLoading(false);
      }, () => cancelled || generation !== requestGenerationRef.current)
      : Promise.resolve();
    const pageTask = pageRequest.then((page) => {
      if (cancelled || generation !== requestGenerationRef.current) return;
      if (mediaLibrary) {
        const mediaPage = page as MediaResourcePage;
        setItems(mediaPage.resources.map((resource) => mediaResourceListItem(resource, surface.notebookPath)).filter((item): item is DocumentPageItem => item !== null));
        setFolders([]);
        setNextCursor(mediaPage.nextCursor);
        setHasMore(mediaPage.hasMore);
        // Show the independently loaded resource page without waiting for all
        // explicit record paths to resolve.
        if (hasMediaDataset) setLoading(false);
      } else {
        const documentPage = page as DocumentPage;
        setItems(documentPage.items);
        setFolders(documentPage.folders);
        setNextCursor(documentPage.nextCursor);
        setHasMore(documentPage.hasMore);
        setLoading(false);
      }
    }).catch((error) => {
      logger.warn('loading document page failed', { error });
      if (!cancelled && generation === requestGenerationRef.current) setError(true);
    });
    const linkedTask = linkedRequest.catch((error) => {
      logger.warn('loading linked media records failed', { error });
    }).then(() => {
      if (!cancelled && generation === requestGenerationRef.current) {
        setLinkedItems([...nextLinkedItems]);
        setLoadingLinkedItems(false);
        if (mediaLibrary && !hasMediaDataset) setLoading(false);
      }
    });
    void Promise.all([pageTask, linkedTask]).finally(() => {
      if (!cancelled && generation === requestGenerationRef.current) {
        loadingRef.current = false;
        setLoading(false);
        if (pendingRefreshRef.current) {
          pendingRefreshRef.current = false;
          setRevision((value) => value + 1);
        }
      }
    });
    return () => { cancelled = true; requestGenerationRef.current += 1; };
  }, [hasMediaDataset, hasLinkedMedia, refreshPaused, mediaLibrary, mediaLibraryRecords, revision, surface.displayId, surface.folderPath, surface.mediaScope?.relativePath, surface.mediaScope?.depth, surface.mediaDatasetActive, surface.notebookId, surface.notebookPath, resourceKindsKey]);
  const loadMore = useCallback(() => {
    if (!surface.notebookId || refreshPausedRef.current || (mediaLibrary && !hasMediaDataset) || !nextCursor || loading || loadingMore || !hasMore) return;
    const generation = requestGenerationRef.current;
    setLoadingMore(true);
    setMoreError(false);
    const pageRequest = mediaLibrary
      ? mediaResources.listPage(surface.notebookPath, (surface.filters.resourceKinds ?? ['image', 'video']).filter((kind): kind is 'image' | 'video' => kind === 'image' || kind === 'video'), nextCursor, MEDIA_LIBRARY_PAGE_SIZE, surface.mediaScope?.relativePath ?? null, surface.mediaScope?.depth)
      : files.listDocumentPage({ notebookId: surface.notebookId, folderPath: surface.folderPath, resourceKinds: surface.filters.resourceKinds, cursor: nextCursor });
    void pageRequest.then((page) => {
      if (generation !== requestGenerationRef.current) return;
      const nextItems = mediaLibrary
        ? (page as MediaResourcePage).resources.map((resource) => mediaResourceListItem(resource, surface.notebookPath)).filter((item): item is DocumentPageItem => item !== null)
        : (page as DocumentPage).items;
      setItems((current) => [...current, ...nextItems]);
      setNextCursor(page.nextCursor);
      setHasMore(page.hasMore);
    }).catch((error) => {
      logger.warn('loading next document page failed', { error });
      if (generation === requestGenerationRef.current) setMoreError(true);
    }).finally(() => {
      if (generation === requestGenerationRef.current) setLoadingMore(false);
    });
  }, [hasMediaDataset, hasMore, loading, loadingMore, mediaLibrary, nextCursor, resourceKindsKey, surface.filters.resourceKinds, surface.folderPath, surface.mediaScope?.relativePath, surface.mediaScope?.depth, surface.mediaDatasetActive, surface.notebookId, surface.notebookPath]);
  return { items, linkedItems, folders, loading, loadingLinkedItems, loadingMore, moreError, hasMore,
    hasMediaDataset, hasLinkedMedia, error, loadMore, refresh: requestRefresh };
}
