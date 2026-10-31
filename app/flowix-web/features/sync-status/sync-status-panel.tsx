'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { GitCompare, X } from 'lucide-react';
import { ArrowsClockwiseIcon, CheckCircleIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { Button } from '@shared/ui/button';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { errorMessage } from '@/lib/error-message';
import {
  fns,
  type FnsConflictAction,
  type FnsConflictView,
  type FnsConfigView,
  type FnsNotebookState,
  type FnsSyncPhase,
  type FnsSyncRecord,
} from '@platform/tauri/client';
import { useNoteStore } from '@features/memo/store/note-store';
import { flushOpenDocumentsForNotebook, formatSyncOutcomeSummary, reloadOpenDocumentsAfterSync } from '@features/document/public/sync-coordination';
import { useSyncPanelStore } from './sync-panel-store';
import { ConflictDiffDialog } from './conflict-diff-dialog';

const PHASE_KEYS: Record<FnsSyncPhase, I18nKey> = {
  scanning: 'sync.panel.phaseScanning',
  notesPull: 'sync.panel.phaseNotesPull',
  notesPush: 'sync.panel.phaseNotesPush',
  filesPull: 'sync.panel.phaseFilesPull',
  filesPush: 'sync.panel.phaseFilesPush',
};

const PILL = 'inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium leading-none tabular-nums';
const PILL_RECEIVE = `${PILL} bg-[color-mix(in_oklch,var(--info)_12%,transparent)] text-[var(--info)]`;
const PILL_SEND = `${PILL} bg-[color-mix(in_oklch,var(--warning)_16%,transparent)] text-[color-mix(in_oklch,var(--warning)_72%,var(--foreground))]`;
const PILL_MUTED = `${PILL} bg-[var(--muted)] text-[var(--muted-foreground)]`;
const CHIP = 'min-w-0 truncate rounded-md bg-[var(--muted)] px-1.5 py-0.5 text-[11px] leading-4 text-[var(--muted-foreground)]';

function formatTime(value: number, language: string): string {
  const date = new Date(value);
  const sameDay = date.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(language === 'zh-CN' ? 'zh-CN' : 'en-US', sameDay
    ? { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }
    : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false },
  ).format(date);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

function InfoRow({ label, title, children }: {
  label: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="shrink-0 text-[var(--muted-foreground)]">{label}</span>
      <span className="min-w-0 truncate text-right text-[var(--foreground)]" title={title}>
        {children}
      </span>
    </div>
  );
}

function RecordRow({ record, language }: { record: FnsSyncRecord; language: string }) {
  const { t } = useI18n();
  const fileCount = record.filesPulled + record.filesPushed;
  const noChanges = record.ok && record.pulled === 0 && record.pushed === 0 && fileCount === 0;
  return (
    <div className="relative rounded-lg py-1.5 pl-3.5 pr-1.5 hover:bg-[var(--hover-bg)]">
      {/* Timeline accent bar, like the reference log: green = ok, red = failed. */}
      <span
        aria-hidden
        className={`absolute bottom-1.5 left-0 top-1.5 w-[3px] rounded-full ${
          record.ok ? 'bg-[var(--success)]' : 'bg-[var(--destructive)]'
        }`}
      />
      <div className="flex items-center gap-1.5">
        <span className="shrink-0 text-[11px] tabular-nums text-[var(--muted-foreground)]">
          {formatTime(record.at, language)}
        </span>
        <span
          className={`truncate text-xs font-medium ${
            record.ok ? 'text-[var(--foreground)]' : 'text-[var(--destructive)]'
          }`}
        >
          {record.ok ? t('sync.panel.done') : t('sync.panel.failed')}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {record.pulled > 0 && (
            <span className={PILL_RECEIVE}>↓ {t('sync.panel.receive')} {record.pulled}</span>
          )}
          {record.pushed > 0 && (
            <span className={PILL_SEND}>↑ {t('sync.panel.send')} {record.pushed}</span>
          )}
          {noChanges && <span className={PILL_MUTED}>{t('sync.panel.noChanges')}</span>}
          {record.ok
            ? <CheckCircleIcon weight="fill" className="h-3.5 w-3.5 shrink-0 text-[var(--success)]" />
            : <WarningCircleIcon weight="fill" className="h-3.5 w-3.5 shrink-0 text-[var(--destructive)]" />}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-1.5">
        <span className={CHIP} title={record.vault || record.notebookId}>
          {record.vault || record.notebookId}
        </span>
        {fileCount > 0 && (
          <span className={`${PILL_MUTED} shrink-0`}>📎 ↓{record.filesPulled} ↑{record.filesPushed}</span>
        )}
        <span className="ml-auto shrink-0 text-[11px] tabular-nums text-[var(--muted-foreground)]">
          {formatDuration(record.durationMs)}
        </span>
      </div>
      {!record.ok && record.error && (
        <p className="mt-1 break-words text-[11px] leading-4 text-[var(--destructive)]">{record.error}</p>
      )}
    </div>
  );
}

function ConflictRow({
  conflict,
  busy,
  disabled,
  onResolve,
  onDismiss,
  onViewDiff,
}: {
  conflict: FnsConflictView;
  busy: boolean;
  disabled: boolean;
  onResolve: (action: FnsConflictAction) => void;
  onDismiss: () => void;
  onViewDiff: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-1 rounded-lg border border-[var(--border)] bg-[var(--card)] px-2 py-1.5">
      <button
        type="button"
        className="flex w-full items-center gap-1 rounded text-left"
        onClick={onViewDiff}
        title={t('sync.conflict.viewDiff')}
      >
        <GitCompare className="h-3 w-3 shrink-0 text-[var(--muted-foreground)]" />
        <span className="truncate text-xs text-[var(--foreground)] underline decoration-dotted underline-offset-2">
          {conflict.path}
        </span>
      </button>
      <div className="flex items-center gap-1">
        {conflict.mergeable && (
          <Button
            size="sm"
            variant="outline"
            className="h-6 rounded-md px-2 text-[11px]"
            disabled={disabled}
            title={t('sync.conflict.mergeHint')}
            onClick={() => onResolve('merge')}
          >
            {busy ? t('sync.panel.running') : t('sync.conflict.merge')}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          className="h-6 rounded-md px-2 text-[11px]"
          disabled={disabled}
          onClick={() => onResolve('keepLocal')}
        >
          {t('sync.conflict.keepLocal')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-6 rounded-md px-2 text-[11px]"
          disabled={disabled}
          onClick={() => onResolve('keepRemote')}
        >
          {t('sync.conflict.keepRemote')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-6 w-6 rounded-md p-0"
          aria-label={t('sync.conflict.dismiss')}
          title={t('sync.conflict.dismiss')}
          disabled={disabled}
          onClick={onDismiss}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

export function SyncStatusPanel() {
  const { t, language } = useI18n();
  const open = useSyncPanelStore((state) => state.open);
  const setOpen = useSyncPanelStore((state) => state.setOpen);
  const selectedNotebookId = useNoteStore((state) => state.selectedNotebookId);

  const [config, setConfig] = useState<FnsConfigView | null>(null);
  const [notebookState, setNotebookState] = useState<FnsNotebookState | null>(null);
  const [conflicts, setConflicts] = useState<FnsConflictView[]>([]);
  const [conflictBusy, setConflictBusy] = useState<string | null>(null);
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const [legacyCopies, setLegacyCopies] = useState<string[]>([]);
  const [legacyBusy, setLegacyBusy] = useState(false);
  const [selectedTokenId, setSelectedTokenId] = useState('');
  const [vault, setVault] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const nextConfig = await fns.getConfig();
    setConfig(nextConfig);
    if (selectedNotebookId) {
      setNotebookState(await fns.getNotebookState(selectedNotebookId));
      setConflicts(await fns.listConflicts(selectedNotebookId).catch(() => []));
      setLegacyCopies(await fns.listLegacyConflictCopies(selectedNotebookId).catch(() => []));
    } else {
      setNotebookState(null);
      setConflicts([]);
      setLegacyCopies([]);
    }
  }, [selectedNotebookId]);

  const isRunning = notebookState?.status.running === true;

  useEffect(() => {
    if (!open) return;
    void refresh().catch(() => {});
    // Poll faster while a sync is running so progress feels live.
    const timer = setInterval(() => {
      void refresh().catch(() => {});
    }, isRunning ? 800 : 3000);
    return () => clearInterval(timer);
  }, [open, refresh, isRunning]);

  useEffect(() => {
    if (!notebookState) return;
    if (notebookState.bound) {
      setSelectedTokenId(notebookState.tokenId);
      setVault(notebookState.vault);
    } else if (!selectedTokenId && config?.tokens.length === 1) {
      setSelectedTokenId(config.tokens[0].id);
    }
  }, [config?.tokens, notebookState, selectedTokenId]);

  // Edge swipe: start near the right edge and drag left to open. Pointer
  // Events are used instead of Touch Events because remote-desktop clients
  // (e.g. an Android tablet driving a Windows host) usually deliver touches as
  // pointer/mouse input, so `touchstart` never fires.
  useEffect(() => {
    if (open) return;
    let startX = 0;
    let startY = 0;
    let tracking = false;

    const edgeWidth = () => Math.max(56, Math.min(140, window.innerWidth * 0.08));

    const stopTracking = () => {
      tracking = false;
      document.body.style.userSelect = '';
    };

    const onDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      if (event.clientX < window.innerWidth - edgeWidth()) return;
      tracking = true;
      startX = event.clientX;
      startY = event.clientY;
      document.body.style.userSelect = 'none';
    };

    const onUp = (event: PointerEvent) => {
      if (!tracking) return;
      const dx = event.clientX - startX;
      const dy = Math.abs(event.clientY - startY);
      stopTracking();
      if (dx < -48 && dy < Math.max(70, Math.abs(dx) * 0.75)) {
        useSyncPanelStore.getState().setOpen(true);
      }
    };

    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', stopTracking, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', stopTracking, true);
      document.body.style.userSelect = '';
    };
  }, [open]);

  const bind = useCallback(async () => {
    if (!selectedNotebookId || !selectedTokenId) return;
    setBusy(true);
    try {
      setNotebookState(await fns.bindNotebook(selectedNotebookId, selectedTokenId, vault));
      toast.success(t('sync.panel.bound'));
      try {
        await flushOpenDocumentsForNotebook(selectedNotebookId);
        await fns.syncNotebook(selectedNotebookId);
        await reloadOpenDocumentsAfterSync(selectedNotebookId);
        await refresh();
      } catch (error) {
        // Binding succeeded; the first sync may still fail (permissions, etc.).
        toast.error(`${t('sync.panel.failed')}: ${errorMessage(error)}`);
      }
    } catch (error) {
      toast.error(`${t('sync.panel.failed')}: ${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  }, [refresh, selectedNotebookId, selectedTokenId, t, vault]);

  const unbind = useCallback(async () => {
    if (!selectedNotebookId) return;
    setBusy(true);
    try {
      await fns.unbindNotebook(selectedNotebookId);
      await refresh();
      toast.success(t('sync.panel.unbound'));
    } catch (error) {
      toast.error(`${t('sync.panel.failed')}: ${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  }, [refresh, selectedNotebookId, t]);

  const syncNow = useCallback(async () => {
    if (!selectedNotebookId) return;
    setBusy(true);
    // Reflect progress immediately; the backend flips `running` a moment later.
    void refresh().catch(() => {});
    try {
      // The engine reads and writes notebook files on disk while editor saves
      // are blur/debounce-triggered: capture pending edits first, and feed
      // pulled remote changes back into the open views afterwards.
      await flushOpenDocumentsForNotebook(selectedNotebookId);
      const outcome = await fns.syncNotebook(selectedNotebookId);
      await reloadOpenDocumentsAfterSync(selectedNotebookId);
      await refresh();
      if (outcome) {
        toast.success(formatSyncOutcomeSummary(outcome, t));
      } else {
        toast.error(t('sync.panel.skipped'));
      }
    } catch (error) {
      toast.error(`${t('sync.panel.failed')}: ${errorMessage(error)}`);
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }, [refresh, selectedNotebookId, t]);

  const resolveConflict = useCallback(async (path: string, action: FnsConflictAction) => {
    if (!selectedNotebookId) return;
    setConflictBusy(path);
    try {
      // keepRemote/merge rewrite the file: capture open editors first and
      // feed the rewritten content back into the views afterwards.
      if (action !== 'keepLocal') {
        await flushOpenDocumentsForNotebook(selectedNotebookId);
      }
      await fns.resolveConflict(selectedNotebookId, path, action);
      await reloadOpenDocumentsAfterSync(selectedNotebookId);
      await refresh();
      toast.success(t('sync.conflict.resolved'));
    } catch (error) {
      toast.error(`${t('sync.panel.failed')}: ${errorMessage(error)}`);
    } finally {
      setConflictBusy(null);
    }
  }, [refresh, selectedNotebookId, t]);

  const dismissConflict = useCallback(async (path: string) => {
    if (!selectedNotebookId) return;
    setConflictBusy(path);
    try {
      await fns.dismissConflict(selectedNotebookId, path);
      await refresh();
      toast.success(t('sync.conflict.dismissed'));
    } catch (error) {
      toast.error(`${t('sync.panel.failed')}: ${errorMessage(error)}`);
    } finally {
      setConflictBusy(null);
    }
  }, [refresh, selectedNotebookId, t]);

  const cleanupLegacy = useCallback(async () => {
    if (!selectedNotebookId) return;
    setLegacyBusy(true);
    try {
      await flushOpenDocumentsForNotebook(selectedNotebookId);
      const deleted = await fns.cleanupLegacyConflictCopies(selectedNotebookId);
      await reloadOpenDocumentsAfterSync(selectedNotebookId);
      await refresh();
      toast.success(t('sync.panel.legacyCleaned').replace('{count}', String(deleted)));
    } catch (error) {
      toast.error(`${t('sync.panel.failed')}: ${errorMessage(error)}`);
    } finally {
      setLegacyBusy(false);
    }
  }, [refresh, selectedNotebookId, t]);

  const globalStatus = notebookState?.status;
  const status = globalStatus && globalStatus.notebookId === selectedNotebookId
    ? globalStatus
    : null;
  const syncing = busy || status?.running === true;
  const lastRecord = notebookState?.history[0];
  const lastSync = lastRecord
    ? formatTime(lastRecord.at, language)
    : t('sync.panel.never');
  const retryAt = status?.nextRetryAt ? formatTime(status.nextRetryAt, language) : null;
  const headerDot = syncing
    ? 'bg-[var(--brand)] animate-pulse'
    : status?.lastError
      ? 'bg-[var(--destructive)]'
      : notebookState?.bound
        ? 'bg-[var(--success)]'
        : 'bg-[var(--muted-foreground)]';

  return (
    <>
      <div
        aria-hidden={!open}
        className={`fixed inset-0 z-40 bg-black/10 transition-opacity duration-200 ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        onClick={() => setOpen(false)}
      />
      <aside
        aria-label={t('sync.panel.title')}
        className={`fixed right-0 top-0 z-50 flex h-full w-[340px] max-w-[86vw] flex-col border-l border-[var(--border)] bg-[var(--card)] shadow-2xl transition-transform duration-200 ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <header className="flex items-center gap-2 px-3 pb-2 pt-9">
          <ArrowsClockwiseIcon className="h-4 w-4 text-[var(--muted-foreground)]" />
          <span className="flex-1 text-sm font-medium text-[var(--foreground)]">
            {t('sync.panel.title')}
          </span>
          <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${headerDot}`} />
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 rounded-lg p-0"
            aria-label={t('sync.panel.close')}
            title={t('sync.panel.close')}
            onClick={() => setOpen(false)}
          >
            <X className="h-4 w-4" />
          </Button>
        </header>

        <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 pb-4">
          {!selectedNotebookId ? (
            <p className="py-6 text-center text-xs text-[var(--muted-foreground)]">
              {t('sync.panel.noNotebook')}
            </p>
          ) : !notebookState?.bound ? (
            <div className="space-y-2.5 rounded-xl bg-[color-mix(in_oklch,var(--muted)_40%,transparent)] p-3 text-xs">
              <p className="text-[var(--muted-foreground)]">{t('sync.panel.notBound')}</p>
              <label className="block space-y-1">
                <span className="text-[var(--muted-foreground)]">{t('sync.panel.token')}</span>
                <select
                  className="h-8 w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-2 text-sm"
                  value={selectedTokenId}
                  onChange={(event) => setSelectedTokenId(event.target.value)}
                >
                  <option value="">{t('sync.panel.noToken')}</option>
                  {config?.tokens.map((token) => (
                    <option key={token.id} value={token.id}>{token.label}</option>
                  ))}
                </select>
              </label>
              <label className="block space-y-1">
                <span className="text-[var(--muted-foreground)]">{t('sync.panel.vault')}</span>
                <input
                  className="h-8 w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-2 text-sm"
                  value={vault}
                  placeholder={t('sync.panel.vaultHint')}
                  onChange={(event) => setVault(event.target.value)}
                />
              </label>
              <Button
                size="sm"
                className="w-full rounded-lg"
                disabled={busy || !selectedTokenId}
                onClick={() => void bind()}
              >
                {t('sync.panel.bind')}
              </Button>
            </div>
          ) : (
            <div className="space-y-1.5 rounded-xl bg-[color-mix(in_oklch,var(--muted)_40%,transparent)] px-3 py-2.5 text-xs">
              <InfoRow label={t('sync.panel.vault')} title={notebookState.vault}>
                {notebookState.vault}
              </InfoRow>
              <InfoRow label={t('sync.panel.token')} title={notebookState.tokenLabel ?? notebookState.tokenId}>
                {notebookState.tokenLabel ?? notebookState.tokenId}
              </InfoRow>
              <InfoRow label={t('sync.panel.status')}>
                {syncing
                  ? (
                      <span className="inline-flex items-center gap-1.5 text-[var(--brand)]">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--brand)]" />
                        {t('sync.panel.running')}
                      </span>
                    )
                  : t('sync.panel.idle')}
              </InfoRow>
              <InfoRow label={t('sync.panel.lastSync')}>{lastSync}</InfoRow>
              {retryAt && (
                <InfoRow label={t('sync.panel.retryAt')}>{retryAt}</InfoRow>
              )}
              {status?.progress && (
                <div className="space-y-1 pt-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[var(--muted-foreground)]">
                      {t(PHASE_KEYS[status.progress.phase])}
                    </span>
                    {status.progress.phase !== 'scanning' && (
                      <span className="tabular-nums text-[var(--foreground)]">
                        {Math.min(status.progress.completed + 1, Math.max(status.progress.total, 1))}
                        /{status.progress.total}
                      </span>
                    )}
                  </div>
                  {status.progress.phase !== 'scanning' && (
                    <div className="h-1.5 overflow-hidden rounded-full bg-[var(--muted)]">
                      <div
                        className="h-full rounded-full bg-[var(--brand,#6366f1)] transition-[width] duration-200"
                        style={{
                          width: `${status.progress.total > 0
                            ? Math.min(100, Math.round((status.progress.completed / status.progress.total) * 100))
                            : 0}%`,
                        }}
                      />
                    </div>
                  )}
                  {status.progress.currentPath && (
                    <p className="truncate text-[var(--muted-foreground)]" title={status.progress.currentPath}>
                      {status.progress.currentPath}
                    </p>
                  )}
                </div>
              )}
              {status?.lastError && (
                <p className="break-words pt-0.5 text-[var(--destructive)]">{status.lastError}</p>
              )}
            </div>
          )}

          {notebookState?.bound && (
            <div className="flex gap-2">
              <Button
                size="sm"
                className="h-8 flex-1 rounded-lg"
                disabled={syncing}
                onClick={() => void syncNow()}
              >
                {syncing ? t('sync.panel.running') : t('sync.panel.syncCurrent')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 rounded-lg"
                disabled={syncing}
                onClick={() => void unbind()}
              >
                {t('sync.panel.unbind')}
              </Button>
            </div>
          )}

          {notebookState?.bound && conflicts.length > 0 && (
            <section className="space-y-1.5 rounded-xl border border-[color-mix(in_oklch,var(--warning)_40%,var(--border))] bg-[color-mix(in_oklch,var(--warning)_10%,transparent)] p-2.5">
              <div className="flex items-center gap-1.5 px-0.5 text-xs font-medium text-[color-mix(in_oklch,var(--warning)_70%,var(--foreground))]">
                <WarningCircleIcon weight="fill" className="h-3.5 w-3.5" />
                {t('sync.panel.conflicts').replace('{count}', String(conflicts.length))}
              </div>
              {conflicts.map((conflict) => (
                <ConflictRow
                  key={conflict.path}
                  conflict={conflict}
                  busy={conflictBusy === conflict.path}
                  disabled={conflictBusy !== null}
                  onResolve={(action) => void resolveConflict(conflict.path, action)}
                  onDismiss={() => void dismissConflict(conflict.path)}
                  onViewDiff={() => setDiffPath(conflict.path)}
                />
              ))}
            </section>
          )}

          <ConflictDiffDialog
            notebookId={selectedNotebookId ?? ''}
            path={diffPath}
            busy={conflictBusy !== null}
            onResolve={(path, action) => void resolveConflict(path, action)}
            onClose={() => setDiffPath(null)}
          />

          {notebookState?.bound && conflicts.length === 0 && legacyCopies.length > 0 && (
            <section className="space-y-1 rounded-xl bg-[color-mix(in_oklch,var(--muted)_40%,transparent)] p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-xs font-medium text-[var(--muted-foreground)]">
                  {t('sync.panel.legacyCopies').replace('{count}', String(legacyCopies.length))}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 shrink-0 rounded-md px-2 text-[11px]"
                  disabled={legacyBusy}
                  onClick={() => void cleanupLegacy()}
                >
                  {t('sync.panel.cleanup')}
                </Button>
              </div>
              <p className="truncate text-[11px] text-[var(--muted-foreground)]" title={legacyCopies.join('\n')}>
                {legacyCopies[0]}
                {legacyCopies.length > 1 && ` +${legacyCopies.length - 1}`}
              </p>
            </section>
          )}

          <section className="pt-0.5">
            <div className="pb-1 text-xs font-medium text-[var(--muted-foreground)]">
              {t('sync.panel.history')}
            </div>
            {(notebookState?.history.length ?? 0) === 0 ? (
              <p className="py-6 text-center text-xs text-[var(--muted-foreground)]">
                {t('sync.panel.empty')}
              </p>
            ) : (
              <div className="space-y-0.5">
                {notebookState?.history.map((record, index) => (
                  <RecordRow key={`${record.at}-${index}`} record={record} language={language} />
                ))}
              </div>
            )}
          </section>
        </div>
      </aside>
    </>
  );
}
