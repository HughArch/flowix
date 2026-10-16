'use client';

import { ArrowCircleUpIcon } from '@phosphor-icons/react';
import type { AppUpdaterState } from '@features/shell/hooks/use-app-updater';
import { useI18n } from '@/lib/i18n';

/** Status-bar entry that opens the app update prompt. */
export function ProductUpdatePill({ updater, onClick }: { updater: AppUpdaterState; onClick: () => void }) {
  const { t } = useI18n();
  const { status, update } = updater;

  if (!update || !update.notify || status === 'error' || status === 'none' || status === 'idle' || status === 'checking') {
    return null;
  }

  const versionLabel = t('appUpdates.statusBarVersion', {
    version: update.version.replace(/^v/i, ''),
  });
  const isDownloading = status === 'downloading';

  return (
    <button
      type="button"
      onClick={onClick}
      title={versionLabel}
      className="inline-flex h-[22px] items-center justify-center gap-1 rounded-md px-2 text-xs leading-none text-[var(--primary)] hover:bg-[var(--muted)]"
      aria-label={versionLabel}
    >
      {isDownloading
        ? <DownloadProgressIcon progress={updater.progress} />
        : <ArrowCircleUpIcon className="h-[18px] w-[18px]" weight="fill" aria-hidden="true" />}
      <span>{versionLabel}</span>
    </button>
  );
}

function DownloadProgressIcon({ progress }: { progress: AppUpdaterState['progress'] }) {
  let hasProgress = false;
  let percent = 0;
  if (progress?.phase === 'progress' && progress.contentLength && progress.contentLength > 0) {
    hasProgress = true;
    percent = Math.min(1, Math.max(0, progress.downloadedBytes / progress.contentLength));
  }
  const radius = 9;
  const circumference = 2 * Math.PI * radius;

  return (
    <svg
      aria-hidden="true"
      className={`h-[18px] w-[18px] shrink-0${hasProgress ? '' : ' flowix-spin'}`}
      viewBox="0 0 24 24"
    >
      <circle cx="12" cy="12" r={radius} fill="none" stroke="currentColor" strokeOpacity="0.24" strokeWidth="3" />
      <circle
        cx="12"
        cy="12"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="3"
        strokeDasharray={hasProgress ? circumference : `${circumference * 0.28} ${circumference * 0.72}`}
        strokeDashoffset={hasProgress ? circumference * (1 - percent) : 0}
        transform="rotate(-90 12 12)"
      />
    </svg>
  );
}
