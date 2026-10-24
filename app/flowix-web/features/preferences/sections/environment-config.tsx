'use client';

import { useEffect, useState } from 'react';
import { boot, product, type ProductInfo } from '@platform/tauri/client';
import { Button } from '@shared/ui/button';
import { Tooltip } from '@shared/ui/tooltip';
import { toast } from '@/lib/toast';
import { useI18n } from '@/lib/i18n';
import { FieldRow, SectionHeader } from '@features/preferences/sections/primitives';

interface EnvironmentConfigSectionProps {
  productInfo: ProductInfo | null;
}

export function EnvironmentConfigSection({ productInfo }: EnvironmentConfigSectionProps) {
  const { t } = useI18n();
  const [versionInitializationCompleted, setVersionInitializationCompleted] = useState<boolean | null>(null);
  const [savingVersionInitialization, setSavingVersionInitialization] = useState(false);

  useEffect(() => {
    let active = true;
    if (!productInfo?.isDevBuild) {
      setVersionInitializationCompleted(null);
      return () => { active = false; };
    }
    void boot.getVersionInitializationCompleted().then((completed) => {
      if (active) setVersionInitializationCompleted(completed);
    }).catch(() => {
      if (active) toast.error(t('preferences.environmentConfig.versionInitialization.loadFailed'));
    });
    return () => { active = false; };
  }, [productInfo?.isDevBuild, t]);

  const handleVersionInitializationChange = async () => {
    if (versionInitializationCompleted === null || savingVersionInitialization) return;
    const completed = !versionInitializationCompleted;
    setSavingVersionInitialization(true);
    try {
      await boot.setVersionInitializationCompleted(completed);
      setVersionInitializationCompleted(completed);
      toast.success(t(completed
        ? 'preferences.environmentConfig.versionInitialization.markedComplete'
        : 'preferences.environmentConfig.versionInitialization.rerunNextLaunch'));
    } catch {
      toast.error(t('preferences.environmentConfig.versionInitialization.saveFailed'));
    } finally {
      setSavingVersionInitialization(false);
    }
  };

  const handleOpenLogDir = async () => {
    try {
      await product.openLogDir();
    } catch {
      toast.error(t('preferences.environmentConfig.runtimeLogs.openFailed'));
    }
  };

  return (
    <div className="space-y-6">
      <SectionHeader title={t('preferences.environmentConfig.title')} />

      {productInfo?.isDevBuild && (
        <FieldRow
          title={t('preferences.environmentConfig.versionInitialization.title')}
          description={t('preferences.environmentConfig.versionInitialization.description')}
        >
          <button
            type="button"
            role="switch"
            aria-checked={versionInitializationCompleted === true}
            aria-label={t('preferences.environmentConfig.versionInitialization.title')}
            disabled={versionInitializationCompleted === null || savingVersionInitialization}
            onClick={() => void handleVersionInitializationChange()}
            className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
              versionInitializationCompleted ? 'bg-[var(--primary)]' : 'bg-[var(--muted)]'
            }`}
          >
            <span
              className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-[var(--card)] shadow-sm transition-transform ${
                versionInitializationCompleted ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </button>
        </FieldRow>
      )}

      <FieldRow
        title={t('preferences.environmentConfig.runtimeLogs.title')}
        description={productInfo?.logDir ?? t('preferences.environmentConfig.runtimeLogs.description')}
      >
        <Tooltip content={t('preferences.environmentConfig.runtimeLogs.openFolder')}>
          <Button variant="outline" className="px-3" onClick={() => void handleOpenLogDir()}>
            {t('preferences.environmentConfig.runtimeLogs.open')}
          </Button>
        </Tooltip>
      </FieldRow>
    </div>
  );
}
