'use client';

import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@shared/ui/button';
import { Dialog, DialogContent } from '@shared/ui/dialog';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { errorMessage } from '@/lib/error-message';
import { fns, type FnsConflictAction, type FnsConflictDetail } from '@platform/tauri/client';
import { composeConflictDiff, composeTwoWayDiff, type DiffSegment } from './conflict-diff';

const SEGMENT_LABEL_KEYS: Record<Exclude<DiffSegment['kind'], 'context'>, I18nKey> = {
  local: 'sync.diff.local',
  remote: 'sync.diff.remote',
  both: 'sync.diff.both',
};

function SegmentBlock({ segment }: { segment: DiffSegment }) {
  const { t } = useI18n();
  if (segment.kind === 'context') {
    return (
      <div className="whitespace-pre-wrap break-words rounded-md px-2 py-1 text-xs text-[var(--muted-foreground)]">
        {segment.localLines.join('\n')}
      </div>
    );
  }
  if (segment.kind === 'local' || segment.kind === 'remote') {
    const isLocal = segment.kind === 'local';
    return (
      <div
        className={`rounded-md border px-2 py-1 ${
          isLocal
            ? 'border-[color-mix(in_oklch,var(--success)_35%,var(--border))] bg-[color-mix(in_oklch,var(--success)_10%,transparent)]'
            : 'border-[color-mix(in_oklch,var(--brand)_35%,var(--border))] bg-[color-mix(in_oklch,var(--brand)_10%,transparent)]'
        }`}
      >
        <span
          className={`mb-0.5 inline-block rounded px-1 py-px text-[10px] font-medium ${
            isLocal
              ? 'bg-[color-mix(in_oklch,var(--success)_18%,transparent)] text-[var(--success,#16a34a)]'
              : 'bg-[color-mix(in_oklch,var(--brand)_18%,transparent)] text-[var(--brand,#6366f1)]'
          }`}
        >
          {t(SEGMENT_LABEL_KEYS[segment.kind])}
        </span>
        <div className="whitespace-pre-wrap break-words text-xs text-[var(--foreground)]">
          {(isLocal ? segment.localLines : segment.remoteLines).join('\n')}
        </div>
      </div>
    );
  }
  // Both sides changed the same region: stack the two candidate versions.
  return (
    <div className="space-y-1 rounded-md border border-[color-mix(in_oklch,var(--destructive)_40%,var(--border))] bg-[color-mix(in_oklch,var(--destructive)_6%,transparent)] px-2 py-1">
      <div>
        <span className="mb-0.5 inline-block rounded bg-[color-mix(in_oklch,var(--success)_18%,transparent)] px-1 py-px text-[10px] font-medium text-[var(--success,#16a34a)]">
          {t('sync.diff.local')}
        </span>
        <div className="whitespace-pre-wrap break-words text-xs text-[var(--foreground)]">
          {segment.localLines.join('\n')}
        </div>
      </div>
      <div className="border-t border-dashed border-[var(--border)]" />
      <div>
        <span className="mb-0.5 inline-block rounded bg-[color-mix(in_oklch,var(--brand)_18%,transparent)] px-1 py-px text-[10px] font-medium text-[var(--brand,#6366f1)]">
          {t('sync.diff.remote')}
        </span>
        <div className="whitespace-pre-wrap break-words text-xs text-[var(--foreground)]">
          {segment.remoteLines.join('\n')}
        </div>
      </div>
    </div>
  );
}

interface ConflictDiffDialogProps {
  notebookId: string;
  path: string | null;
  busy: boolean;
  onResolve: (path: string, action: FnsConflictAction) => void;
  onClose: () => void;
}

export function ConflictDiffDialog({
  notebookId,
  path,
  busy,
  onResolve,
  onClose,
}: ConflictDiffDialogProps) {
  const { t } = useI18n();
  const [detail, setDetail] = useState<FnsConflictDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    setDetail(null);
    setLoadError(null);
    if (!path) return;
    let cancelled = false;
    fns
      .getConflictDetail(notebookId, path)
      .then((next) => {
        if (!cancelled) setDetail(next);
      })
      .catch((error) => {
        if (!cancelled) setLoadError(errorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [notebookId, path]);

  const diff = useMemo(() => {
    if (!detail) return null;
    // A degraded base (server history lookup missed) would make the
    // three-way view hide the cloud side entirely; fall back to a direct
    // local-vs-remote comparison instead.
    return detail.mergeable
      ? composeConflictDiff(detail.baseContent, detail.localContent, detail.serverContent)
      : composeTwoWayDiff(detail.localContent, detail.serverContent);
  }, [detail]);

  const resolve = (action: FnsConflictAction) => {
    if (!path) return;
    onResolve(path, action);
    onClose();
  };

  return (
    <Dialog open={path !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[85vh] w-[94vw] max-w-[680px] flex-col" showCloseButton={!busy}>
        {path === null ? null : (
          <>
            <div className="mb-2 flex items-center gap-2 pr-8">
              <span className="truncate text-sm font-semibold text-[var(--foreground)]" title={path}>
                {path}
              </span>
              {detail?.mergeable && (
                <span className="shrink-0 rounded bg-[color-mix(in_oklch,var(--success)_15%,transparent)] px-1.5 py-px text-[10px] text-[var(--success,#16a34a)]">
                  {t('sync.diff.mergeable')}
                </span>
              )}
            </div>

            <div className="min-h-0 flex-1 space-y-1.5 overflow-auto rounded-lg border border-[var(--border)] bg-[var(--card)] p-2">
              {detail && !detail.mergeable && !loadError && (
                <p className="rounded-md bg-[color-mix(in_oklch,var(--warning,#eab308)_12%,transparent)] px-2 py-1 text-[11px] text-[var(--muted-foreground)]">
                  {t('sync.diff.degradedHint')}
                </p>
              )}
              {loadError ? (
                <p className="px-1 py-6 text-center text-xs text-[var(--destructive)]">
                  {t('sync.diff.loadFailed')}: {loadError}
                </p>
              ) : !detail || !diff ? (
                <div className="flex items-center justify-center gap-2 py-10 text-xs text-[var(--muted-foreground)]">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('sync.diff.loading')}
                </div>
              ) : diff.identical ? (
                <p className="px-1 py-6 text-center text-xs text-[var(--muted-foreground)]">
                  {t('sync.diff.identical')}
                </p>
              ) : (
                diff.segments.map((segment, index) => (
                  <SegmentBlock key={index} segment={segment} />
                ))
              )}
            </div>

            <div className="mt-3 flex items-center justify-end gap-2">
              <Button
                size="sm"
                variant="outline"
                className="rounded-lg"
                disabled={busy || !detail}
                onClick={() => resolve('keepLocal')}
              >
                {t('sync.conflict.keepLocal')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="rounded-lg"
                disabled={busy || !detail}
                onClick={() => resolve('keepRemote')}
              >
                {t('sync.conflict.keepRemote')}
              </Button>
              {detail?.mergeable && (
                <Button
                  size="sm"
                  className="rounded-lg"
                  disabled={busy || !detail}
                  onClick={() => resolve('merge')}
                >
                  {t('sync.conflict.merge')}
                </Button>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
