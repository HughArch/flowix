'use client';

import { reuseCollectionValue } from '@features/collection/content-equality';
import { isLegacyCollectionSource } from '@features/collection/model';
import { collectionDisplayDescriptor } from '@/lib/collection-display-registry';
import { subscribe } from '@platform/tauri/event-bus';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { externalDocuments, files } from '@platform/tauri/client';
import { canonicalDirectoryPath, canonicalPath } from '@/lib/path';
import { useNoteStore } from '@features/memo/store/note-store';
import { DocumentListView } from '@features/surface/document-list-view';
import type { DocumentListSurface } from '@features/surface/types';
import { ensureFileDisplayIdentity, findFileDisplayIdentity, findFileDisplayPath, type FileDisplayIdentity } from '@/lib/file-display-registry';
import { displayTitleFromFilename, mediaLibraryExtension } from '@/lib/utils';
import { replaceExternalDocumentPath } from '@features/workspace/use-cases/workspace-navigation';
import { toast } from '@/lib/toast';
import { useI18n } from '@/lib/i18n';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { mediaCollectionFilterFromCondition, mediaLibraryDefaultView, mediaLibraryFileCondition, parseMediaLibrary, serializeMediaLibrary, type MediaLibraryDocument, type MediaLibraryFileCondition, type MediaLibraryKind } from './model';
import { renameMediaLibraryFile } from './rename-media-library';
import { useMediaLibraryActions } from './use-media-library-actions';

export function MediaLibraryView({ filePath, fileIdentity, notebookPath: rawNotebookPath, notebookId = null, expectedCollectionId }: { filePath: string; fileIdentity?: FileDisplayIdentity; notebookPath: string | null; notebookId?: string | null; expectedCollectionId?: string | null }) {
  const notebookPath = rawNotebookPath ? canonicalDirectoryPath(rawNotebookPath) : null;
  const { t } = useI18n();
  const notebooks = useNoteStore((state) => state.notebooks);
  const notebook = notebooks.find((candidate) => canonicalDirectoryPath(candidate.path) === (notebookPath ?? ''));
  const [renamedFilePath, setRenamedFilePath] = useState<string | null>(null);
  const [document, setDocument] = useState<MediaLibraryDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDeleteLibrary, setConfirmDeleteLibrary] = useState(false);
  const sourceContentRef = useRef<string | null>(null);
  const saveInFlightRef = useRef(false);
  const displayId = fileIdentity?.displayId;
  const currentFilePath = (displayId ? findFileDisplayPath(displayId) : null) ?? renamedFilePath ?? filePath;

  useEffect(() => setRenamedFilePath(null), [filePath]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    if (saveInFlightRef.current) {
      setLoading(false);
      return;
    }
    if (!notebookPath) {
      setError('无法确定媒体库所属的笔记本');
      setLoading(false);
      return;
    }
    sourceContentRef.current = null;
    void files.read(currentFilePath, notebookPath).then(async (source) => {
      if (cancelled) return;
      if (!source) throw new Error('无法读取媒体库文件');
      let parsed = parseMediaLibrary(source);
      const expectedId = expectedCollectionId ?? (displayId ? collectionDisplayDescriptor(displayId)?.collectionId : null);
      if (expectedId && parsed.collection.id !== expectedId) throw new Error('集合身份已变化，不能打开路径中的替代文件');
      let currentSource = source;
      if (isLegacyCollectionSource(source)) {
        const migration = await externalDocuments.write({ filePath: currentFilePath, content: serializeMediaLibrary(parsed), expectedContent: source, scopePath: notebookPath });
        if (migration.status === 'saved') currentSource = migration.content;
        else if (migration.status === 'conflict') {
          const latest = parseMediaLibrary(migration.diskContent);
          if (latest.collection.id !== parsed.collection.id) throw new Error('集合身份已变化，无法迁移旧格式');
          parsed = latest;
          currentSource = migration.diskContent;
        } else if (migration.status === 'error') throw new Error(migration.message);
      }
      sourceContentRef.current = currentSource;
      setDocument(parsed);
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [displayId ?? currentFilePath, notebookPath]);

  useEffect(() => subscribe<{ notebookId: string; collectionId: string; relativePath: string }>('collection-changed', (event) => {
    if (event.notebookId !== (notebookId ?? notebook?.id) || event.collectionId !== document?.collection.id || !notebookPath || saveInFlightRef.current) return;
    void externalDocuments.read(`${canonicalDirectoryPath(notebookPath)}/${event.relativePath}`, notebookPath).then((content) => {
      if (saveInFlightRef.current) return;
      const next = parseMediaLibrary(content);
      if (next.collection.id !== event.collectionId) return;
      sourceContentRef.current = content;
      setDocument((current) => current ? { ...next,
        dataset: { ...next.dataset, records: reuseCollectionValue(current.dataset.records, next.dataset.records) },
        views: reuseCollectionValue(current.views, next.views),
      } : next);
    }).catch(() => undefined);
  }), [document?.collection.id, notebook?.id, notebookId, notebookPath]);

  const persistMutation = useCallback(async (
    mutate: (current: MediaLibraryDocument) => MediaLibraryDocument,
    targetPath = currentFilePath,
    lockAlreadyHeld = false,
    initialDocument?: MediaLibraryDocument,
  ): Promise<boolean> => {
    if (!document || !notebookPath || !sourceContentRef.current
      || (saveInFlightRef.current && !lockAlreadyHeld)) return false;
    if (!lockAlreadyHeld) {
      saveInFlightRef.current = true;
      setSaving(true);
    }
    try {
      let baseline = initialDocument ?? document;
      let expectedContent = sourceContentRef.current;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (baseline.collection.id !== document.collection.id) throw new Error('集合身份已变化，已取消保存');
        const next = mutate(baseline);
        const result = await externalDocuments.write({
          filePath: targetPath,
          content: serializeMediaLibrary(next),
          expectedContent,
          scopePath: notebookPath,
        });
        if (result.status === 'saved') {
          sourceContentRef.current = result.content;
          setDocument(next);
          return true;
        }
        if (result.status === 'conflict') {
          const latest = parseMediaLibrary(result.diskContent);
          if (latest.collection.id !== baseline.collection.id) throw new Error('集合身份已变化，已取消保存');
          expectedContent = result.diskContent;
          sourceContentRef.current = result.diskContent;
          if (attempt === 0) {
            baseline = latest;
            continue;
          }
          setDocument(latest);
          toast.error('媒体库配置再次发生变化，已载入最新版本，请重试');
          return false;
        }
        throw new Error(result.status === 'error' ? result.message : '媒体库文件已不存在');
      }
      return false;
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : '保存媒体库配置失败');
      return false;
    } finally {
      if (!lockAlreadyHeld) {
        saveInFlightRef.current = false;
        setSaving(false);
      }
    }
  }, [currentFilePath, document, notebookPath]);

  const updateFilterCondition = useCallback(async (fileCondition: MediaLibraryFileCondition) => {
    if (saving) return false;
    return persistMutation((current) => ({
      ...current,
      collection: {
        ...current.collection,
        revision: current.collection.revision + 1,
        updated_at: new Date().toISOString(),
      },
      dataset: { ...current.dataset, filter: Object.keys(fileCondition).length > 0
        ? mediaCollectionFilterFromCondition(fileCondition)
        : null },
      views: { ...current.views, items: current.views.items.map((view) => view.id === current.views.default_id
        ? { ...view, filter: { all: [], any: [] } } : view) },
    }));
  }, [persistMutation, saving]);

  const renameLibraryFile = useCallback(async (rawTitle: string) => {
    const title = rawTitle.trim();
    const previousPath = canonicalPath(displayId ? findFileDisplayPath(displayId) ?? currentFilePath : currentFilePath);
    const currentTitle = displayTitleFromFilename(previousPath);
    const extension = mediaLibraryExtension(previousPath);
    if (!title || title === currentTitle || saving || !notebookPath || !document || saveInFlightRef.current) return;
    if (/[\\/]/.test(title)) {
      toast.error('文件名不能包含路径分隔符');
      return;
    }
    if (!extension) {
      toast.error('无法识别媒体库文件后缀');
      return;
    }

    try {
      const identity = fileIdentity ?? findFileDisplayIdentity(previousPath) ?? ensureFileDisplayIdentity(previousPath);
      saveInFlightRef.current = true;
      setSaving(true);
      const result = await renameMediaLibraryFile({
        filePath: previousPath, notebookPath, notebookId: notebookId ?? notebook?.id, collectionId: document.collection.id, title,
        onRenamed: (nextPath) => {
          replaceExternalDocumentPath(identity.displayId, previousPath, nextPath);
          setRenamedFilePath(nextPath);
        },
      });
      sourceContentRef.current = result.content;
      setDocument((current) => current ? { ...result.document,
        dataset: { ...result.document.dataset, records: reuseCollectionValue(current.dataset.records, result.document.dataset.records) },
        views: reuseCollectionValue(current.views, result.document.views),
      } : result.document);
      if (result.metadataError) toast.error(`文件已重命名，配置名称未能保存：${result.metadataError}`);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : '重命名媒体库失败');
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  }, [currentFilePath, displayId, document, fileIdentity, notebookPath, saving]);

  const { addMedia, deleteMedia } = useMediaLibraryActions({
    document, setDocument, notebookPath, notebookId: notebookId ?? notebook?.id ?? null, currentFilePath, saving, setSaving,
    sourceContentRef, saveInFlightRef, persistMutation, t,
  });

  const deleteLibraryFile = useCallback(() => {
    if (!currentFilePath || !notebookPath || saving || saveInFlightRef.current) return;
    setConfirmDeleteLibrary(true);
  }, [currentFilePath, notebookPath, saving]);

  const confirmDeleteLibraryFile = useCallback(() => {
    if (!currentFilePath || !notebookPath || saving || saveInFlightRef.current) return;
    setConfirmDeleteLibrary(false);
    window.dispatchEvent(new CustomEvent('flowix:request-delete-external-file', {
      detail: { filePath: currentFilePath, notebookPath },
    }));
  }, [currentFilePath, notebookPath, saving]);



  const selectedKind = document ? mediaLibraryFileCondition(document).file_type : undefined;
  const resourceKinds = useMemo<MediaLibraryKind[]>(() => selectedKind ? [selectedKind] : ['image', 'video'], [selectedKind]);
  const activeCollectionId = document?.collection.id;
  const libraryDisplayName = document?.collection.placement === 'folder'
    ? currentFilePath.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '').split(/[\\/]/).pop() || document.collection.name
    : document?.collection.name ?? '媒体库';
  const mediaScope = useMemo(() => {
    if (!document || !notebookPath) return undefined;
    const source = document.dataset.source;
    if (!source || source.scope === 'notebook') return undefined;
    if (source.scope === 'folder') return { relativePath: source.path ?? '', depth: source.depth };
    const root = canonicalDirectoryPath(notebookPath).replace(/\/$/, '');
    const folder = canonicalDirectoryPath(currentFilePath.replace(/[\\/][^\\/]*$/, '')).replace(/\/$/, '');
    if (folder === root) return { relativePath: '', depth: source.depth };
    if (!folder.startsWith(`${root}/`)) return undefined;
    return { relativePath: folder.slice(root.length + 1).replace(/\\/g, '/'), depth: source.depth };
  }, [currentFilePath, document, notebookPath]);
  const mediaLibraryRecords = useMemo(() => {
    const records = document?.dataset.records.include ?? [];
    if (!mediaScope) return records;
    const base = mediaScope.relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    return records.filter((record) => {
      const path = record.relative_path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      if (!base) return mediaScope.depth === 'descendants' || !path.includes('/');
      if (!path.startsWith(`${base}/`)) return false;
      return mediaScope.depth === 'descendants' || !path.slice(base.length + 1).includes('/');
    });
  }, [document, mediaScope]);
  const mediaLibraryExcludedPaths = useMemo(() => (document?.dataset.records.exclude ?? [])
    .map((record) => record.relative_path)
    .filter((path): path is string => typeof path === 'string'), [document?.dataset.records.exclude]);
  const listSurface: DocumentListSurface | null = useMemo(() => {
    const resolvedNotebookId = notebookId ?? notebook?.id;
    if (!resolvedNotebookId || !notebookPath || !activeCollectionId) return null;
    const libraryIdentity = `media-library:${resolvedNotebookId}:${activeCollectionId}`;
    return {
      kind: 'document-list',
      instanceKey: libraryIdentity,
      displayId: displayId ?? libraryIdentity,
      folderPath: notebookPath,
      notebookPath,
      notebookId: resolvedNotebookId,
      filters: { resourceKinds },
      ...(mediaScope ? { mediaScope } : {}),
      ...(document.dataset.filter !== null ? { mediaDatasetActive: true } : {}),
    };
  }, [activeCollectionId, displayId, document?.dataset.filter, mediaScope, notebook?.id, notebookId, notebookPath, resourceKinds]);

  if (loading) return <div className="flex h-full items-center justify-center text-sm text-[var(--muted-foreground)]">正在打开媒体库…</div>;
  if (error) return <div className="flex h-full items-center justify-center px-6 text-center text-sm text-[var(--destructive)]">{error}</div>;
  if (!document || !listSurface) return <div className="flex h-full items-center justify-center text-sm text-[var(--muted-foreground)]">媒体库不可用</div>;

  return <div className="relative h-full min-h-0">
    {saving && <span className="pointer-events-none absolute right-5 top-4 z-10 text-[11px] text-[var(--muted-foreground)]">保存中…</span>}
    <DocumentListView
      key={listSurface.displayId}
      surface={listSurface}
      mediaLibrary
      libraryName={libraryDisplayName}
      libraryFilePath={currentFilePath}
      mediaLibraryFilter={mediaLibraryFileCondition(document)}
      mediaLibraryRecords={mediaLibraryRecords}
      mediaLibraryExcludedPaths={mediaLibraryExcludedPaths}
      mediaLibraryDatasetFilter={document.dataset.filter}
      mediaLibraryViewFilter={mediaLibraryDefaultView(document).filter}
      onAddMedia={addMedia}
      onDeleteLibrary={document.collection.placement === 'folder' ? undefined : deleteLibraryFile}
      onDeleteMedia={deleteMedia}
      libraryActionsDisabled={saving}
      onMediaLibraryFilterChange={updateFilterCondition}
      onRenameLibrary={document.collection.placement === 'folder' ? undefined : renameLibraryFile}
    />
    <Dialog open={confirmDeleteLibrary} onOpenChange={(open) => { if (!open && !saving) setConfirmDeleteLibrary(false); }}>
      <DialogContent className="rounded-xl border border-[var(--border-popup)] bg-[var(--card)] shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
        <DialogHeader>
          <DialogTitle>{t('document.external.deleteFileTitle')}</DialogTitle>
          <DialogDescription>{t('document.external.deleteFileDescription', { name: currentFilePath.split(/[\\/]/).pop() ?? currentFilePath })}</DialogDescription>
        </DialogHeader>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" disabled={saving} onClick={() => setConfirmDeleteLibrary(false)} className="h-8 rounded-lg px-3 text-sm hover:bg-[var(--muted)] disabled:opacity-50">
            {t('dialog.cancel')}
          </button>
          <button type="button" disabled={saving} onClick={confirmDeleteLibraryFile} className="h-8 rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 text-sm text-[var(--foreground)] hover:border-[var(--destructive)] hover:bg-[var(--destructive)] hover:text-white disabled:opacity-50">
            {t('dialog.delete')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  </div>;
}
