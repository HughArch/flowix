import { useCallback, useEffect, useRef, useState } from 'react';
import {
  consumeAppUpdateResult,
  type AppUpdateInstallResult,
} from '@platform/tauri/client';
import { useAppUpdatePreferences } from '@features/preferences/public/app-api';
import {
  useAppUpdater,
  type AppUpdaterState,
} from '@features/shell/public/system-api';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { useI18n } from '@/lib/i18n';
import { useWorkspaceMemoViewModel } from '@features/memo/public/workspace-api';

const logger = createLogger('main-window-system-controller');

export interface MainWindowSystemController {
  onboardingOpen: boolean;
  onboardingLoading: boolean;
  updater: AppUpdaterState;
  hasPendingAppUpdateResult: boolean;
  presentPendingAppUpdateResult(): void;
  completeOnboarding(): Promise<void>;
}

export function useMainWindowSystemController(): MainWindowSystemController {
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingLoading, setOnboardingLoading] = useState(true);
  const onboardingDecisionMade = useRef(false);
  const { notebooks, startupPhase } = useWorkspaceMemoViewModel();
  const [pendingAppUpdateResult, setPendingAppUpdateResult] = useState<AppUpdateInstallResult | null>(null);
  const { t } = useI18n();
  const updatePreferences = useAppUpdatePreferences();
  const updater = useAppUpdater({
    autoCheck: !updatePreferences.loading,
    enabled: updatePreferences.enabled,
  });

  useEffect(() => {
    void consumeAppUpdateResult().then((result) => {
      if (result) setPendingAppUpdateResult(result);
    }).catch((error) => {
      logger.warn('read previous app update result failed', { error });
    });
  }, []);

  useEffect(() => {
    if (startupPhase !== 'ready' || onboardingDecisionMade.current) return;
    // Notebook identity is resolved in stage 2. Show first-run onboarding only
    // when the notebook list is empty; do not wait for stage 3 or another read.
    onboardingDecisionMade.current = true;
    setOnboardingOpen(notebooks.length === 0);
    setOnboardingLoading(false);
  }, [notebooks.length, startupPhase]);

  const completeOnboarding = useCallback(async () => {
    setOnboardingOpen(false);
  }, []);

  const presentPendingAppUpdateResult = useCallback(() => {
    if (!pendingAppUpdateResult) return;
    const result = pendingAppUpdateResult;
    setPendingAppUpdateResult(null);
    if (result.status === 'failed') {
      toast.error(`${t('appUpdates.previousInstallFailed')}${result.message ? `: ${result.message}` : ''}`);
    } else {
      toast.success(t('appUpdates.installSucceeded'));
    }
  }, [pendingAppUpdateResult, t]);

  return {
    onboardingOpen,
    onboardingLoading,
    updater,
    hasPendingAppUpdateResult: pendingAppUpdateResult !== null,
    presentPendingAppUpdateResult,
    completeOnboarding,
  };
}
