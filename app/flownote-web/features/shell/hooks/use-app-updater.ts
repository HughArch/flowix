import { useCallback, useEffect, useRef, useState } from 'react';
import {
  checkAppUpdate,
  installAppUpdate,
  cancelAppUpdate,
  type AppUpdate,
  type AppUpdateDownloadProgress,
} from '@platform/tauri/client/updater';
import { runStartupStage3Task, waitForStartupStage3 } from '@/lib/startup-stage3';

export type AppUpdaterStatus = 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'installing' | 'error';

export interface AppUpdaterState {
  status: AppUpdaterStatus;
  update: AppUpdate | null;
  progress: AppUpdateDownloadProgress | null;
  error: unknown;
  checkNow: () => Promise<AppUpdate | null>;
  installNow: () => Promise<void>;
  cancelNow: () => Promise<void>;
}

interface UseAppUpdaterOptions {
  autoCheck?: boolean;
  enabled?: boolean;
  delayMs?: number;
}

export function useAppUpdater({
  autoCheck = false,
  enabled = true,
  delayMs = 3_600,
}: UseAppUpdaterOptions = {}): AppUpdaterState {
  const [status, setStatus] = useState<AppUpdaterStatus>('idle');
  const [update, setUpdate] = useState<AppUpdate | null>(null);
  const [progress, setProgress] = useState<AppUpdateDownloadProgress | null>(null);
  const [error, setError] = useState<unknown>(null);
  const updateRef = useRef<AppUpdate | null>(null);
  const checkStartedRef = useRef(false);
  updateRef.current = update;

  const checkNow = useCallback(async () => {
    checkStartedRef.current = true;
    setStatus('checking');
    setError(null);
    setProgress(null);
    try {
      const next = await checkAppUpdate();
      setUpdate(next);
      setStatus(next ? 'available' : 'none');
      return next;
    } catch (checkError) {
      setUpdate(null);
      setStatus('error');
      setError(checkError);
      throw checkError;
    }
  }, []);

  const installNow = useCallback(async () => {
    const current = updateRef.current;
    if (!current) return;

    setStatus('downloading');
    setError(null);
    setProgress(null);
    try {
      await installAppUpdate(current.version, (next) => {
        setProgress(next);
        setStatus(next.phase === 'installing' ? 'installing' : 'downloading');
      });
    } catch (installError) {
      setStatus('available');
      if (!isCancellationError(installError)) setError(installError);
      throw installError;
    }
  }, []);

  const cancelNow = useCallback(async () => {
    await cancelAppUpdate();
    setProgress(null);
    setStatus('available');
  }, []);

  useEffect(() => {
    if (!autoCheck || !enabled) return;
    let cancelled = false;
    let timer: number | undefined;
    void waitForStartupStage3().then(() => {
      if (cancelled) return;
      timer = window.setTimeout(() => {
        if (cancelled) return;
        void runStartupStage3Task('app-update-auto-check', async () => {
          if (cancelled || checkStartedRef.current) return;
          checkStartedRef.current = true;
          try {
            await checkNow();
          } catch {
            // Automatic checks are intentionally silent. The preferences view
            // exposes the error through its explicit check action.
          }
        });
      }, delayMs);
    });
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [autoCheck, enabled, delayMs, checkNow]);

  return { status, update, progress, error, checkNow, installNow, cancelNow };
}

function isCancellationError(error: unknown): boolean {
  return error instanceof Error
    ? error.message.includes('cancelled')
    : String(error).includes('cancelled');
}
