import { useState, type ReactNode } from 'react';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { useWorkspaceStartupStore } from '@/lib/store/workspace-startup-store';
import { boot } from '@platform/tauri/client';
import { CenteredLoadingSpinner } from '@shared/ui/centered-loading-spinner';
import { Button } from '@shared/ui/button';

const startupProgressLabels: Record<string, I18nKey> = {
  prepareDatabasePaths: 'startup.progress.prepareDatabasePaths',
  prepareThreadDatabase: 'startup.progress.prepareThreadDatabase',
  prepareNotebookRegistry: 'startup.progress.prepareNotebookRegistry',
  runMigrations: 'startup.progress.runMigrations',
  config_dsh_layout_v2: 'startup.progress.migrateAgentLayout',
  config_local_migrations_v1: 'startup.progress.migrateLocalConfiguration',
  config_watcher_exclusions_v1: 'startup.progress.migrateWatcherSettings',
  templates_v1: 'startup.progress.prepareTemplates',
  prepareRuntimeStorage: 'startup.progress.prepareRuntimeStorage',
  activateRuntime: 'startup.progress.activateRuntime',
  completeInitialization: 'startup.progress.completeInitialization',
};

function startupProgressLabel(task: string): I18nKey {
  if (task.startsWith('deferred:')) return 'startup.progress.deferredNotebookJobs';
  if (task.includes(':notebook:')) return 'startup.progress.migrateNotebookStorage';
  return startupProgressLabels[task] ?? 'startup.progress.runMigrations';
}

/** Admit the workbench only when native startup enters stage 2, including retries. */
export function StartupGate({ children }: { children: ReactNode }) {
  const stage = useWorkspaceStartupStore((state) => state.nativeStage);
  return stage === 'initialization' ? <VersionInitializationScreen /> : children;
}

/** A standalone first-stage page. No workbench is mounted behind it. */
export function VersionInitializationScreen() {
  const phase = useWorkspaceStartupStore((state) => state.nativePhase);
  const step = useWorkspaceStartupStore((state) => state.nativeStep);
  const progress = useWorkspaceStartupStore((state) => state.nativeProgress);
  const nativeError = useWorkspaceStartupStore((state) => state.nativeError);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const { t } = useI18n();
  const failed = phase === 'failed';
  const initializing = phase === 'running' && step === 'versionInitialization';
  const retry = async () => {
    setRetrying(true);
    setRetryError(null);
    try {
      await boot.retryStartup();
      // Restart the root status subscription, which settles on failure.
      window.location.reload();
    } catch (error) {
      setRetryError(String(error));
      setRetrying(false);
    }
  };

  return (
    <main data-startup-screen="initialization" className="flex min-h-screen items-center justify-center bg-[var(--frame-bg)] px-6 text-[var(--foreground)]">
      <div className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
        {failed ? (
          <div role="alert" className="flex w-full flex-col items-center gap-4 text-sm text-[var(--muted-foreground)]">
            <p>{t('memo.navigation.startupMigrationFailed')}</p>
            {(retryError || nativeError) && <p className="max-h-40 w-full overflow-auto break-words">{retryError || nativeError}</p>}
            <Button disabled={retrying} onClick={() => void retry()}>{t('error.retry')}</Button>
          </div>
        ) : (
          <>
            <CenteredLoadingSpinner label={initializing ? t('memo.navigation.preparingVersion') : undefined} />
            {phase === 'running' && progress && (
              <div className="flex w-72 max-w-full flex-col gap-3 text-xs text-[var(--muted-foreground)]">
                <div role="progressbar" aria-label={t('memo.navigation.preparingVersion')}
                  aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}
                  className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--muted)]">
                  <div className="h-full rounded-full bg-[var(--brand)] transition-[width] duration-300 ease-out motion-reduce:transition-none"
                    style={{ width: `${progress.percent}%` }} />
                </div>
                <div className="flex items-start justify-between gap-3">
                  <span>{t(startupProgressLabel(progress.task))}</span>
                  <span className="tabular-nums">{progress.percent}%</span>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}

/** Retain a branded page until the second-stage workbench code resolves. */
export function StartupEntryScreen() {
  return (
    <div data-startup-screen="entry" className="flex min-h-screen flex-col items-center justify-center gap-6 bg-[var(--frame-bg)] text-[var(--foreground)]">
      <CenteredLoadingSpinner />
    </div>
  );
}
