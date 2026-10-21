'use client';

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useShortcutScope, pushHandler } from '@features/shortcuts';
import { useI18n, type I18nParams } from '@/lib/i18n';
import { useShallow } from 'zustand/react/shallow';
import {
  cloud,
  listenToCloudStateChanges,
  mediaResources,
  notes,
  notebooks as notebooksClient,
  windows as tauriWindows,
  type CloudNotebook,
  type NotebookSetupReport,
} from '@platform/tauri/client';
import { useTauriRpc } from '@platform/tauri/use-tauri-rpc';
import {
  cloudSyncErrorMessage,
  isInvalidRefreshTokenError,
  notebookCreateErrorMessage,
} from '@platform/tauri/errors';
import { useCreateNotebookFlow } from '@features/memo/hooks/use-create-notebook-flow';
import { useEmptyNotebookPrompt } from '@features/memo/hooks/use-empty-notebook-prompt';
import { clearActionableNotice, dismissActionableNotice, upsertActionableNotice } from '@features/notifications/actionable-notice-store';
import { noteRepository, notebookRepository } from '@features/memo/services/note-repository';
import { getVisibleCreateFilter, useNoteStore, useTagStore, type NoteListItem, type Notebook } from '@features/memo/store';
import { noteListItemRelativePath } from '@/types/note-item';
import { upsertNotebookSetupJob, useNotebookSetupJob } from '@features/memo/store/notebook-setup-store';
import { getNotebookIconOption } from '@features/memo/components/notebook-icon';
import { openNotebookNote } from '@features/memo/use-cases/open-notebook-note';
import { clearWorkspaceDocument } from '@features/workspace/use-cases/workspace-navigation';
import { selectNotebook } from '@features/workspace/public/main-window-api';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { joinNotebookMemoPath } from '@/lib/path';
import { Kbd } from '@shared/ui/kbd';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@shared/ui/select';
import { LazyGlobalSearchCommand } from '@features/memo/components/lazy-global-search-command';
import { externalDocuments } from '@platform/tauri/client';
import { subscribePendingOpenTargets } from '@platform/open-target/pending-requests';
import { openWorkspaceSurface } from '@features/workspace/public/open-surface-api';
import { documentIdentityFromFile, saveWorkspaceDocumentPath } from '@features/document/public/workspace-api';
import { ensureFileDisplayIdentity } from '@/lib/file-display-registry';
import {
  FLOWIX_EXTERNAL_MARKDOWN_OPEN_EVENT,
  type ExternalMarkdownOpenRequest,
} from '@platform/open-target/types';

const LazyNotebookDialogs = lazy(() =>
  import('@features/memo/components/notebook-dialogs').then((module) => ({
    default: module.NotebookDialogs,
  })),
);

function normalizeNotebookIconId(icon: string | null | undefined): string | null {
  return getNotebookIconOption(icon) ? icon! : null;
}

interface MediaDeleteRequest {
  filePath: string;
  notebookPath: string;
}

function filenameFromPath(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
}

function DeleteDialogShortcuts({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useShortcutScope('dialog');

  useEffect(() => {
    const popCancel = pushHandler('dialog.cancel', onCancel);
    const popConfirm = pushHandler('dialog.confirm', () => {
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)
      ) {
        return false;
      }
      onConfirm();
    });
    return () => {
      popCancel();
      popConfirm();
    };
  }, [onCancel, onConfirm]);

  return null;
}

function BlockingOperationStatus({ text, stacked }: { text: string; stacked: boolean }) {
  return (
    <div className="pointer-events-auto fixed inset-0 z-[140] flex items-center justify-center bg-[color-mix(in_oklch,var(--card)_82%,transparent)] backdrop-blur-[1px]">
      <div className={cn('flex items-center gap-2 px-3 py-2 text-sm text-[var(--foreground)]', stacked && 'flex-col')} role="status" aria-live="polite">
        <Loader2 className="h-4 w-4 flowix-spin text-[var(--primary)]" />
        <span>{text}</span>
      </div>
    </div>
  );
}

function ExternalMarkdownOpenDialog() {
  const { t } = useI18n();
  const selectedNotebook = useNoteStore((state) => state.selectedNotebook);
  const notebooks = useNoteStore((state) => state.notebooks);
  const [requests, setRequests] = useState<ExternalMarkdownOpenRequest[]>([]);
  const request = requests[0] ?? null;
  const dismissCurrentRequest = useCallback(() => setRequests((current) => current.slice(1)), []);
  const [notebookId, setNotebookId] = useState('');
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    const onRequest = (next: ExternalMarkdownOpenRequest) => {
      if (!next?.filePaths?.length) return;
      setRequests((current) => [...current, next]);
    };
    const unlisten = subscribePendingOpenTargets('external-markdown', ({ target }) => {
      if (target.kind === 'external-markdown') onRequest({ filePaths: target.filePaths });
    });
    const onWindowRequest = (event: Event) => {
      onRequest((event as CustomEvent<ExternalMarkdownOpenRequest>).detail);
    };
    window.addEventListener(FLOWIX_EXTERNAL_MARKDOWN_OPEN_EVENT, onWindowRequest);
    return () => {
      unlisten();
      window.removeEventListener(FLOWIX_EXTERNAL_MARKDOWN_OPEN_EVENT, onWindowRequest);
    };
  }, []);

  useEffect(() => {
    if (!request) return;
    setNotebookId((current) => (
      notebooks.some((notebook) => notebook.id === current)
        ? current
        : selectedNotebook?.id || notebooks[0]?.id || ''
    ));
  }, [notebooks, request, selectedNotebook?.id]);

  const close = useCallback(() => {
    if (!opening) dismissCurrentRequest();
  }, [opening, dismissCurrentRequest]);

  const open = useCallback(async () => {
    if (!request || !notebookId) return;
    setOpening(true);
    try {
      const imported: string[] = [];
      for (const filePath of request.filePaths) {
        const content = await externalDocuments.read(filePath, null);
        const created = await notes.importDocument(filePath, content, notebookId);
        imported.push(created.path);
        useNoteStore.getState().upsertCreatedNote(created);
      }
      dismissCurrentRequest();
      const notebook = useNoteStore.getState().notebooks.find((item) => item.id === notebookId);
      if (notebook) await openNotebookNote(imported[imported.length - 1], notebook);
    } catch (error) {
      toast.error(`${t('memo.externalOpen.failed')}: ${String(error)}`);
    } finally {
      setOpening(false);
    }
  }, [notebookId, request, t, dismissCurrentRequest]);

  const openDirectly = useCallback(async () => {
    if (!request) return;
    setOpening(true);
    try {
      for (const filePath of request.filePaths) {
        await openWorkspaceSurface({
          host: 'main-third',
          target: { kind: 'external', path: filePath, scopePath: null, transitionId: null },
        });
      }
      dismissCurrentRequest();
    } catch (error) {
      toast.error(`${t('memo.externalOpen.failed')}: ${String(error)}`);
    } finally {
      setOpening(false);
    }
  }, [request, t, dismissCurrentRequest]);

  const filenames = request?.filePaths.map((path) => path.split(/[\\/]/).pop() || path) ?? [];
  return (
    <Dialog open={!!request} onOpenChange={(openState) => !openState && close()}>
      <DialogContent showCloseButton={!opening}>
        <DialogHeader>
          <DialogTitle>{t('memo.externalOpen.title')}</DialogTitle>
        </DialogHeader>
        <div className="mt-3 max-h-24 overflow-auto rounded-lg border border-[var(--border)] px-3 py-2 text-xs text-[var(--muted-foreground)]">
          {filenames.map((filename) => <div key={filename} className="truncate">{filename}</div>)}
        </div>
        <label className="mt-4 block text-sm text-[var(--foreground)]">
          {t('memo.externalOpen.saveTo')}
          <Select
            value={notebookId}
            onValueChange={setNotebookId}
            disabled={opening}
          >
            <SelectTrigger className="mt-2 w-full">
              <span className="min-w-0 flex-1 truncate text-left">
                {notebooks.find((notebook) => notebook.id === notebookId)?.name ?? ''}
              </span>
            </SelectTrigger>
            <SelectContent align="start" className="flowix-preferences-select-content w-72 max-w-[calc(100vw-2rem)]">
              {notebooks.map((notebook) => (
                <SelectItem key={notebook.id} value={notebook.id}>{notebook.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={close} disabled={opening} className="h-8 rounded-lg px-3 text-sm hover:bg-[var(--muted)]">
            {t('dialog.cancel')}
          </button>
          <button type="button" onClick={() => void openDirectly()} disabled={opening} className="h-8 rounded-lg border border-[var(--border)] px-3 text-sm hover:bg-[var(--muted)] disabled:opacity-50">
            {t('memo.externalOpen.openDirectly')}
          </button>
          <button type="button" onClick={() => void open()} disabled={opening || !notebookId} className="h-8 rounded-lg bg-[var(--primary)] px-4 text-sm text-[var(--primary-foreground)] disabled:opacity-50">
            {opening ? t('memo.externalOpen.opening') : t('memo.externalOpen.save')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Application-level host for memo actions that must remain available while
 * the middle column switches from MemoList to AgentConversationList.
 *
 * This component intentionally renders no list. It owns only global event
 * bridges, dialogs, command-palette state, and memo/notebook commands.
 */
export function MemoListServicesHost({
  notebookCreateRequest,
  onRefresh,
  suppressEmptyNotebookPrompt = false,
}: {
  notebookCreateRequest: number;
  onRefresh: () => void;
  suppressEmptyNotebookPrompt?: boolean;
}) {
  const { request } = useTauriRpc();
  const { t } = useI18n();
  const selectedNotebook = useNoteStore((state) => state.selectedNotebook);
  const notebooks = useNoteStore((state) => state.notebooks);
  const activeFilter = useNoteStore((state) => state.activeFilter);
  const startupPhase = useNoteStore((state) => state.startupPhase);
  const selectedTagId = useTagStore((state) => state.selectedTagId);
  const setSelectedTagId = useTagStore((state) => state.setSelectedTagId);
  const {
    setSelectedNotebook,
    setNotebooks,
    setActiveFilter,
    triggerRefresh,
    triggerMemoListRefresh,
  } = useNoteStore(
    useShallow((state) => ({
      setSelectedNotebook: state.setSelectedNotebook,
      setNotebooks: state.setNotebooks,
      setActiveFilter: state.setActiveFilter,
      triggerRefresh: state.triggerRefresh,
      triggerMemoListRefresh: state.triggerMemoListRefresh,
    })),
  );

  const [deleteMemo, setDeleteMemo] = useState<NoteListItem | null>(null);
  const [deleteMedia, setDeleteMedia] = useState<MediaDeleteRequest | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPath, setNewPath] = useState('');
  const [newDefaultPath, setNewDefaultPath] = useState('');
  const [newIcon, setNewIcon] = useState<string | null>(null);
  const [newTemplateId, setNewTemplateId] = useState<string | null>(null);
  const [createMode, setCreateMode] = useState<'create' | 'cloud'>('create');
  const [remoteNotebooks, setRemoteNotebooks] = useState<CloudNotebook[]>([]);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [syncingRemoteId, setSyncingRemoteId] = useState<string | null>(null);
  const [cloudImporting, setCloudImporting] = useState(false);
  const [editingNotebook, setEditingNotebook] = useState<Notebook | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const [editIcon, setEditIcon] = useState<string | null>(null);
  const [editCloudSync, setEditCloudSync] = useState(false);
  const [originalEditCloudSync, setOriginalEditCloudSync] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [cloudSyncAvailable, setCloudSyncAvailable] = useState(false);
  const notebookSetupJob = useNotebookSetupJob(selectedNotebook?.id);
  const [notebookSetupNotice, setNotebookSetupNotice] = useState<NotebookSetupReport | null>(null);
  const [dismissedNotebookSetupKey, setDismissedNotebookSetupKey] = useState<string | null>(null);
  const previousNotebookSetupJobRef = useRef(notebookSetupJob);
  const activeSetupNoticeIdRef = useRef<string | null>(null);

  const { creationState, createNotebook } = useCreateNotebookFlow({
    onMemoListReloadNeeded: onRefresh,
  });

  useEffect(() => {
    let dismissedSetupKey: string | null = null;
    if (selectedNotebook?.id) {
      try {
        dismissedSetupKey = window.localStorage.getItem(
          `flowix:notebook-setup-dismissed:${selectedNotebook.id}`,
        );
      } catch {
        // Dismissal still works for the current session without persistent storage.
      }
    }
    setDismissedNotebookSetupKey(dismissedSetupKey);
  }, [selectedNotebook?.id]);

  useEffect(() => {
    const previous = previousNotebookSetupJobRef.current;
    if (previous?.notebookId !== notebookSetupJob?.notebookId) setNotebookSetupNotice(null);
    if (previous && notebookSetupJob
      && previous.notebookId === notebookSetupJob.notebookId
      && previous.jobId === notebookSetupJob.jobId
      && previous.runId === notebookSetupJob.runId
      && previous.status === 'running'
      && notebookSetupJob.status === 'completed'
      && (notebookSetupJob.report?.skippedExistingFiles ?? 0) > 0) {
      setNotebookSetupNotice(notebookSetupJob.report);
    }
    previousNotebookSetupJobRef.current = notebookSetupJob;
  }, [notebookSetupJob]);

  const retryNotebookSetup = useCallback(async (notebookId: string) => {
    try {
      const job = await notebooksClient.startTemplateSetup(notebookId, true);
      if (job && useNoteStore.getState().selectedNotebook?.id === notebookId) {
        upsertNotebookSetupJob(job);
      }
    } catch (error) {
      throw new Error(notebookCreateErrorMessage(error, t));
    }
  }, [t]);

  const setupJobNoticeKey = notebookSetupJob
    ? `${notebookSetupJob.jobId}:${notebookSetupJob.runId || notebookSetupJob.revision}:${notebookSetupJob.status}`
    : null;
  const notebookSetupNoticeDismissed = setupJobNoticeKey !== null
    && dismissedNotebookSetupKey === setupJobNoticeKey;
  const dismissNotebookSetupNotice = useCallback(() => {
    if (!setupJobNoticeKey || !notebookSetupJob) return;
    setDismissedNotebookSetupKey(setupJobNoticeKey);
    try {
      window.localStorage.setItem(
        `flowix:notebook-setup-dismissed:${notebookSetupJob.notebookId}`,
        setupJobNoticeKey,
      );
    } catch {
      // Keep the notice dismissible for this session when persistent storage is unavailable.
    }
  }, [notebookSetupJob, setupJobNoticeKey]);

  useEffect(() => {
    const job = notebookSetupJob;
    const previousId = activeSetupNoticeIdRef.current;
    if (job?.status !== 'partial' && job?.status !== 'failed') {
      if (previousId) clearActionableNotice(previousId);
      activeSetupNoticeIdRef.current = null;
      return;
    }
    const noticeId = `notebook-setup:${job.notebookId}`;
    if (previousId && previousId !== noticeId) clearActionableNotice(previousId);
    activeSetupNoticeIdRef.current = noticeId;
    if (notebookSetupNoticeDismissed) return;

    const failedFiles = job.report?.failedFiles ?? 0;
    const summary = failedFiles > 0
      ? t('notebook.setup.partialSummary', {
        written: job.report?.writtenFiles ?? 0,
        existing: job.report?.skippedExistingFiles ?? 0,
        failed: failedFiles,
        path: job.report?.firstFailurePath ?? '',
        reason: job.report?.firstFailureReason ?? '',
      })
      : null;
    const details = [
      summary,
      job.message ? notebookCreateErrorMessage(job.message, t) : null,
    ].filter(Boolean).join('\n');
    upsertActionableNotice({
      id: noticeId,
      priority: 50,
      tone: 'error',
      title: `${selectedNotebook?.name ?? t('notebook.create.title')} · ${t(job.status === 'partial' ? 'notebook.setup.partial' : 'notebook.setup.failed')}`,
      message: details || undefined,
      revision: `${job.updatedAt}:${job.status}:${failedFiles}:${job.message ?? ''}`,
      dismissible: true,
      onDismiss: dismissNotebookSetupNotice,
      actions: [{
        id: 'retry',
        label: t('notebook.setup.retry'),
        variant: 'default',
        run: () => retryNotebookSetup(job.notebookId),
      }],
    });
  }, [dismissNotebookSetupNotice, notebookSetupJob, notebookSetupNoticeDismissed, retryNotebookSetup, selectedNotebook?.name, t]);

  useEffect(() => {
    const job = notebookSetupJob;
    if (!job || job.status !== 'completed' || !notebookSetupNotice
      || notebookSetupNotice.skippedExistingFiles <= 0) return;
    const noticeId = `notebook-setup-result:${job.notebookId}`;
    upsertActionableNotice({
      id: noticeId,
      priority: 40,
      tone: 'neutral',
      title: t('notebook.setup.completedWithSkips', {
        written: notebookSetupNotice.writtenFiles,
        existing: notebookSetupNotice.skippedExistingFiles,
      }),
      revision: `${job.updatedAt}:${notebookSetupNotice.writtenFiles}:${notebookSetupNotice.skippedExistingFiles}`,
      actions: [{
        id: 'hide',
        label: t('notebook.setup.hide'),
        variant: 'outline',
        run: () => dismissActionableNotice(noticeId),
      }],
    });
    return () => clearActionableNotice(noticeId);
  }, [notebookSetupJob, notebookSetupNotice, t]);

  useEffect(() => () => {
    if (activeSetupNoticeIdRef.current) clearActionableNotice(activeSetupNoticeIdRef.current);
  }, []);

  const resetCreateState = useCallback(() => {
    setCreateOpen(false);
    setCreateMode('create');
    setNewName('');
    setNewPath('');
    setNewDefaultPath('');
    setNewIcon(null);
    setNewTemplateId(null);
    setRemoteNotebooks([]);
    setRemoteLoading(false);
    setSyncingRemoteId(null);
  }, []);

  const openCreate = useCallback(() => {
    setNewName('');
    setNewPath('');
    setNewDefaultPath('');
    setNewIcon(null);
    setNewTemplateId(null);
    setCreateMode('create');
    setRemoteNotebooks([]);
    setRemoteLoading(false);
    setSyncingRemoteId(null);
    setCreateOpen(true);
  }, []);

  useEffect(() => {
    const name = newName.trim();
    if (!createOpen || createMode !== 'create' || newPath.trim() || !name) {
      setNewDefaultPath('');
      return;
    }

    let cancelled = false;
    void notebookRepository.getDefaultPath(name)
      .then((path) => {
        if (!cancelled) setNewDefaultPath(path);
      })
      .catch(() => {
        if (!cancelled) setNewDefaultPath('');
      });

    return () => {
      cancelled = true;
    };
  }, [createMode, createOpen, newName, newPath]);

  useEffect(() => {
    if (notebookCreateRequest > 0) openCreate();
  }, [notebookCreateRequest, openCreate]);

  useEmptyNotebookPrompt({
    startupReady: startupPhase === 'ready',
    hasSelectedNotebook: Boolean(selectedNotebook),
    suppressed: suppressEmptyNotebookPrompt,
    openCreate,
  });

  useEffect(() => {
    if (!editOpen || !editingNotebook) return;
    let cancelled = false;
    void Promise.all([cloud.getState(), cloud.getNotebookState(editingNotebook.id)])
      .then(([cloudState, link]) => {
        if (cancelled) return;
        const enabled = Boolean(link?.enabled);
        setCloudSyncAvailable(cloudState.authenticated);
        setEditCloudSync(enabled);
        setOriginalEditCloudSync(enabled);
      })
      .catch(() => {
        if (!cancelled) setCloudSyncAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [editOpen, editingNotebook]);

  useEffect(() => listenToCloudStateChanges((state) => {
    setCloudSyncAvailable(state.authenticated);
  }), []);

  useEffect(() => {
    const handleOpenCreate = () => openCreate();
    const handleOpenEdit = (event: Event) => {
      const notebook = (event as CustomEvent<Notebook>).detail;
      if (!notebook) return;
      setEditSaving(false);
      setEditingNotebook(notebook);
      setEditName(notebook.name);
      setEditIcon(normalizeNotebookIconId(notebook.icon));
      setEditOpen(true);
    };
    const handleDeleteMemo = (event: Event) => {
      const memo = (event as CustomEvent<NoteListItem>).detail;
      if (memo) setDeleteMemo(memo);
    };
    const handleDeleteMedia = (event: Event) => {
      const request = (event as CustomEvent<MediaDeleteRequest>).detail;
      if (request?.filePath && request?.notebookPath) setDeleteMedia(request);
    };
    const handleTogglePalette = () => setSearchOpen((open) => !open);
    const handleOpenPalette = () => setSearchOpen(true);
    window.addEventListener('flowix:open-create-notebook', handleOpenCreate);
    window.addEventListener('flowix:open-edit-notebook', handleOpenEdit as EventListener);
    window.addEventListener('flowix:request-delete-memo', handleDeleteMemo as EventListener);
    window.addEventListener('flowix:request-delete-media', handleDeleteMedia as EventListener);
    window.addEventListener('flowix:toggle-palette', handleTogglePalette);
    window.addEventListener('flowix:open-palette', handleOpenPalette);
    return () => {
      window.removeEventListener('flowix:open-create-notebook', handleOpenCreate);
      window.removeEventListener('flowix:open-edit-notebook', handleOpenEdit as EventListener);
      window.removeEventListener('flowix:request-delete-memo', handleDeleteMemo as EventListener);
      window.removeEventListener('flowix:request-delete-media', handleDeleteMedia as EventListener);
      window.removeEventListener('flowix:toggle-palette', handleTogglePalette);
      window.removeEventListener('flowix:open-palette', handleOpenPalette);
    };
  }, [openCreate]);

  const handleCreateMemo = useCallback(async () => {
    if (!selectedNotebook) return;
    const createFilter = getVisibleCreateFilter(activeFilter);
    if (createFilter !== activeFilter) {
      setSelectedTagId(null);
      setActiveFilter(createFilter);
    }
    const tagId = createFilter === 'tagged' ? selectedTagId : null;
    let created: Awaited<ReturnType<typeof noteRepository.create>>;
    try {
      created = await noteRepository.create(tagId ?? undefined, selectedNotebook.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      return;
    }
    useNoteStore.getState().upsertCreatedNote(created);
    const shouldSelectNewMemo =
      createFilter === 'all' ||
      (createFilter === 'tagged' && Boolean(tagId)) ||
      createFilter === 'thisWeek' ||
      createFilter === 'thisMonth';
    if (shouldSelectNewMemo) {
      void openNotebookNote(created.path, selectedNotebook, { initialFocus: 'title' });
    }
    triggerMemoListRefresh();
  }, [activeFilter, selectedNotebook, selectedTagId, setActiveFilter, setSelectedTagId, triggerMemoListRefresh]);

  useEffect(() => {
    const handleRequest = () => void handleCreateMemo();
    window.addEventListener('flowix:create-memo', handleRequest);
    return () => window.removeEventListener('flowix:create-memo', handleRequest);
  }, [handleCreateMemo]);

  const handleDeleteConfirm = useCallback(() => {
    if (!deleteMemo) return;
    const memo = deleteMemo;
    setDeleteMemo(null);
    void (async () => {
      const targetNotebook = useNoteStore.getState().notebooks.find((notebook) => notebook.id === memo.notebookId)
        ?? (selectedNotebook?.id === memo.notebookId ? selectedNotebook : null);
      const path = targetNotebook
        ? joinNotebookMemoPath(targetNotebook.path, noteListItemRelativePath(memo))
        : null;
      if (!path) return;
      const saved = await saveWorkspaceDocumentPath(
        documentIdentityFromFile(ensureFileDisplayIdentity(path)),
        path,
        targetNotebook?.path ?? null,
      );
      if (!saved) {
        const status = await notes.pathStatus(path);
        if (status === 'present') {
          toast.error(t('document.save.failed', { message: '当前页签保存失败，未删除笔记' }));
          return;
        }
      }
      const outcome = await noteRepository.delete(path);
      // MemoEvent or the path-deleted fallback owns list and workspace cleanup.
      if (outcome === 'missingCleaned') toast.success(t('memo.delete.missingCleaned'));
    })().catch((error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    });
  }, [deleteMemo, t, triggerRefresh]);

  const handleMediaDeleteConfirm = useCallback(() => {
    if (!deleteMedia) return;
    const request = deleteMedia;
    setDeleteMedia(null);
    void (async () => {
      const ok = await mediaResources.delete(request.filePath, request.notebookPath);
      if (!ok) {
        toast.error(t('media.fileTree.deleteFailed'));
        return;
      }
      await clearWorkspaceDocument();
      triggerRefresh();
      toast.success(t('media.fileTree.deleted', { name: filenameFromPath(request.filePath) }));
    })().catch((error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    });
  }, [deleteMedia, t, triggerRefresh]);

  const handleInvalidCloudSession = useCallback(async (error: unknown) => {
    if (!isInvalidRefreshTokenError(error)) return false;
    try {
      await cloud.logout();
    } catch {
      // The preferences window remains the recovery surface.
    }
    resetCreateState();
    toast.error(t('preferences.cloud.sessionExpired'));
    void tauriWindows.openPreferences('cloudSync').catch(() => undefined);
    return true;
  }, [resetCreateState, t]);

  const openRemoteNotebooks = useCallback(async () => {
    try {
      const state = await cloud.getState();
      setCloudSyncAvailable(state.authenticated);
      if (!state.authenticated) {
        resetCreateState();
        await tauriWindows.openPreferences('cloudSync');
        return;
      }
      setCreateMode('cloud');
      setRemoteLoading(true);
      setRemoteNotebooks(await cloud.listNotebooks());
    } catch (error) {
      if (!await handleInvalidCloudSession(error)) toast.error(cloudSyncErrorMessage(error, t));
    } finally {
      setRemoteLoading(false);
    }
  }, [handleInvalidCloudSession, resetCreateState, t]);

  const selectRemoteNotebook = useCallback(async (remote: CloudNotebook) => {
    if (remote.synced || syncingRemoteId) return;
    try {
      setSyncingRemoteId(remote.id);
      let local = notebooks.find((item) => item.id === remote.id);
      if (!local) {
        const path = await request<string | null>('select_directory');
        if (!path) return;
        local = await createNotebook({
          cloudNotebookId: remote.id,
          name: remote.name,
          path,
          icon: normalizeNotebookIconId(remote.icon),
        }) ?? undefined;
      }
      if (!local) return;
      if (useNoteStore.getState().selectedNotebook?.id !== local.id) {
        await selectNotebook(local, { workColumnTarget: 'clear' });
        if (useNoteStore.getState().selectedNotebook?.id !== local.id) {
          throw new Error(t('memo.navigation.workspacePreparationFailed'));
        }
      }
      setCloudImporting(true);
      await cloud.linkNotebook(local.id, remote.id);
      await cloud.syncNow(local.id);
      resetCreateState();
      onRefresh();
      toast.success(t('notebook.cloudImport.complete'));
    } catch (error) {
      if (!await handleInvalidCloudSession(error)) toast.error(cloudSyncErrorMessage(error, t));
    } finally {
      setCloudImporting(false);
      setSyncingRemoteId(null);
    }
  }, [createNotebook, handleInvalidCloudSession, notebooks, onRefresh, request, resetCreateState, syncingRemoteId, t]);

  const confirmCreate = useCallback(() => {
    if (!newName.trim()) return;
    void createNotebook({ name: newName, path: newPath || undefined, icon: newIcon, templateId: newTemplateId }).then((created) => {
      if (created) resetCreateState();
    });
  }, [createNotebook, newIcon, newName, newPath, newTemplateId, resetCreateState]);

  const closeEdit = useCallback(() => {
    if (editSaving) return;
    setEditOpen(false);
    setEditingNotebook(null);
    setEditName('');
    setEditIcon(null);
    setEditCloudSync(false);
    setOriginalEditCloudSync(false);
    setEditSaving(false);
  }, [editSaving]);

  const confirmEdit = useCallback(async () => {
    if (!editingNotebook || editSaving) return;
    const name = editName.trim();
    const icon = editIcon || null;
    const iconChanged = (icon ?? '') !== (normalizeNotebookIconId(editingNotebook.icon) ?? '');
    const metadataChanged = name !== editingNotebook.name || iconChanged;
    const cloudChanged = editCloudSync !== originalEditCloudSync;
    if (!name || (!metadataChanged && !cloudChanged)) {
      closeEdit();
      return;
    }
    try {
      setEditSaving(true);
      const updated = metadataChanged
        ? await notebookRepository.update(editingNotebook.id, name, icon ?? '')
        : editingNotebook;
      if (!updated) throw new Error(t('memo.list.updateFailed'));
      if (cloudChanged) await cloud.setNotebookEnabled(editingNotebook.id, editCloudSync);
      setNotebooks(useNoteStore.getState().notebooks.map((item) => item.id === updated.id ? updated : item));
      if (useNoteStore.getState().selectedNotebook?.id === updated.id) setSelectedNotebook(updated);
      if (cloudChanged && editCloudSync) {
        void cloud.syncNow(editingNotebook.id).catch((error) => {
          toast.error(cloudSyncErrorMessage(error, t));
        });
      }
      toast.success(t('memo.list.updated'));
      closeEdit();
    } catch (error) {
      toast.error(cloudSyncErrorMessage(error, t));
      setEditSaving(false);
    }
  }, [closeEdit, editCloudSync, editIcon, editName, editSaving, editingNotebook, originalEditCloudSync, setNotebooks, setSelectedNotebook, t]);

  return (
    <>
      <ExternalMarkdownOpenDialog />

      {cloudImporting && (
        <BlockingOperationStatus
          text={t('notebook.cloudImport.syncing')}
          stacked
        />
      )}

      {deleteMemo && <DeleteDialogShortcuts onCancel={() => setDeleteMemo(null)} onConfirm={handleDeleteConfirm} />}
      {deleteMedia && <DeleteDialogShortcuts onCancel={() => setDeleteMedia(null)} onConfirm={handleMediaDeleteConfirm} />}
      <Dialog open={!!deleteMemo} onOpenChange={(open) => !open && setDeleteMemo(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('memo.delete.title')}</DialogTitle>
            <DialogDescription>
              {t('memo.delete.description', { name: deleteMemo?.title ?? '' } satisfies I18nParams)}
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => setDeleteMemo(null)} className="h-8 rounded-lg px-3 text-sm hover:bg-[var(--muted)]">
              {t('memo.delete.cancel')}
            </button>
            <button type="button" onClick={handleDeleteConfirm} className="relative h-8 rounded-lg border border-[var(--border)] bg-[var(--card)] pl-3 pr-7 text-sm text-[var(--foreground)] hover:border-[var(--destructive)] hover:bg-transparent hover:text-[var(--destructive)]">
              {t('memo.delete.confirm')}
              <Kbd className="border-0 !text-[var(--foreground)]">↵</Kbd>
            </button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={!!deleteMedia} onOpenChange={(open) => !open && setDeleteMedia(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('media.fileTree.deleteTitle')}</DialogTitle>
            <DialogDescription>
              {t('media.fileTree.deleteDescription', { name: deleteMedia ? filenameFromPath(deleteMedia.filePath) : '' })}
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => setDeleteMedia(null)} className="h-8 rounded-lg px-3 text-sm hover:bg-[var(--muted)]">
              {t('dialog.cancel')}
            </button>
            <button type="button" onClick={handleMediaDeleteConfirm} className="h-8 rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 text-sm text-[var(--foreground)] hover:border-[var(--destructive)] hover:bg-transparent hover:text-[var(--destructive)]">
              {t('dialog.delete')}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {(createOpen || editOpen) && (
        <Suspense fallback={null}>
          <LazyNotebookDialogs
            createOpen={createOpen}
            onCreateOpenChange={(open) => {
              if (open) setCreateOpen(true);
              else if (creationState.status !== 'creating') resetCreateState();
            }}
            newNotebookName={newName}
            onNewNotebookNameChange={setNewName}
            newNotebookPath={newPath}
            newNotebookDefaultPath={newDefaultPath}
            newNotebookIcon={newIcon}
            onNewNotebookIconChange={setNewIcon}
            newNotebookTemplateId={newTemplateId}
            onNewNotebookTemplateIdChange={setNewTemplateId}
            isCreatingNotebook={creationState.status === 'creating'}
            cloudSyncAvailable={cloudSyncAvailable}
            createMode={createMode}
            remoteNotebooks={remoteNotebooks}
            remoteNotebooksLoading={remoteLoading}
            remoteNotebookSyncingId={syncingRemoteId}
            onOpenRemoteNotebooks={() => void openRemoteNotebooks()}
            onBackToCreate={() => { setCreateMode('create'); setRemoteNotebooks([]); }}
            onSelectRemoteNotebook={(item) => void selectRemoteNotebook(item)}
            onSelectDirectory={async () => {
              const path = await request<string | null>('select_directory');
              if (path) setNewPath(path);
            }}
            onConfirmCreate={confirmCreate}
            onCancelCreate={resetCreateState}
            editOpen={editOpen}
            onEditOpenChange={(open) => open ? setEditOpen(true) : closeEdit()}
            editingNotebook={editingNotebook}
            editNotebookName={editName}
            onEditNotebookNameChange={setEditName}
            editNotebookIcon={editIcon}
            onEditNotebookIconChange={setEditIcon}
            editNotebookCloudSync={editCloudSync}
            onEditNotebookCloudSyncChange={setEditCloudSync}
            onEditNotebookCloudSyncUnavailable={() => {
              void tauriWindows.openPreferences('cloudSync').catch((error) => {
                toast.error(`${t('notebook.cloudSync.failed')}: ${String(error)}`);
              });
            }}
            editSaving={editSaving}
            editNotebookCloudSyncChanged={editCloudSync !== originalEditCloudSync}
            onConfirmEdit={() => void confirmEdit()}
            onCancelEdit={closeEdit}
          />
        </Suspense>
      )}

      <LazyGlobalSearchCommand open={searchOpen} onOpenChange={setSearchOpen} />
    </>
  );
}
