'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { useAppUpdater } from '@features/shell/hooks/use-app-updater';
import { Select, SelectTrigger, SelectContent, SelectItem } from '@shared/ui/select';
import { Button } from '@shared/ui/button';
import { UpdateProgress } from '@shared/ui/update-progress';
import { autostart, type ProductInfo } from '@platform/tauri/client';
import { toast } from '@/lib/toast';
import {
  FieldRow,
  SectionHeader,
  FIELD_TITLE_CLASS,
} from '@features/preferences/sections/primitives';
import { LANGUAGE_OPTIONS, useI18n, type AppLanguage } from '@/lib/i18n';
import type { WindowCloseAction } from '@/lib/constants';

interface GeneralSectionProps {
  language: AppLanguage;
  productInfo: ProductInfo | null;
  windowCloseAction: WindowCloseAction;
  afterGeneral?: ReactNode;
  updateSettings: (updates: {
    language?: AppLanguage;
    windowCloseAction?: WindowCloseAction;
    productUpdates?: Partial<{ lastCheckedAt: number }>;
  }) => Promise<void>;
}

export function GeneralSection({
  language,
  productInfo,
  windowCloseAction,
  afterGeneral,
  updateSettings,
}: GeneralSectionProps) {
  const { t } = useI18n();
  const [versionCopied, setVersionCopied] = useState(false);
  const updater = useAppUpdater();
  const currentLanguageLabel =
    LANGUAGE_OPTIONS.find((option) => option.value === language)?.label ?? language;

  // 托盘相关设置只在桌面端有意义; 移动端 (productInfo.os 为 android/ios) 隐藏。
  const isDesktop =
    productInfo?.os === 'windows' || productInfo?.os === 'macos' || productInfo?.os === 'linux';
  // 开机自启状态真源在 OS (注册表 / LaunchAgent), 不进 UserSettings; 插件 API 异步读。
  const [autostartState, setAutostartState] = useState<'loading' | 'on' | 'off'>('loading');

  useEffect(() => {
    if (!isDesktop) return;
    let cancelled = false;
    setAutostartState('loading');
    autostart
      .isEnabled()
      .then((enabled) => {
        if (!cancelled) setAutostartState(enabled ? 'on' : 'off');
      })
      .catch(() => {
        if (!cancelled) setAutostartState('off');
      });
    return () => {
      cancelled = true;
    };
  }, [isDesktop]);

  const handleToggleAutostart = async (value: string) => {
    const desired = value === 'on';
    if (autostartState === 'loading' || desired === (autostartState === 'on')) return;
    const previous = autostartState;
    setAutostartState(desired ? 'on' : 'off'); // 乐观更新, 失败回滚
    try {
      if (desired) await autostart.enable();
      else await autostart.disable();
    } catch {
      setAutostartState(previous);
      toast.error(t('preferences.general.autostart.failed'));
    }
  };

  const handleCloseActionChange = (value: string) => {
    void updateSettings({ windowCloseAction: value === 'exit' ? 'exit' : 'minimize' });
  };

  const handleCheckProductUpdates = async () => {
    try {
      const update = await updater.checkNow();
      await updateSettings({ productUpdates: { lastCheckedAt: Date.now() } });
      toast.info(
        update
          ? t('preferences.general.productUpdates.found')
          : t('preferences.general.productUpdates.none'),
      );
    } catch {
      toast.error(t('preferences.general.productUpdates.failed'));
    }
  };

  const handleInstallUpdate = async () => {
    try {
      await updater.installNow();
    } catch {
      toast.error(t('appUpdates.installFailed'));
    }
  };

  const currentVersionText = productInfo
    ? `${productInfo.productName} ${productInfo.version} / ${productInfo.os} ${productInfo.arch}`
    : t('preferences.general.loading');

  const handleCopyVersion = async () => {
    if (!productInfo) return;
    try {
      await navigator.clipboard.writeText(currentVersionText);
      setVersionCopied(true);
      toast.success(t('preferences.general.versionCopied'));
      window.setTimeout(() => setVersionCopied(false), 1600);
    } catch {
      toast.error(t('preferences.general.versionCopyFailed'));
    }
  };

  const checkingUpdates = updater.status === 'checking';
  const downloadingUpdate = updater.status === 'downloading';
  const installingUpdate = updater.status === 'installing';
  const updatingProduct = downloadingUpdate || installingUpdate;
  const downloadPercent = updater.progress?.phase === 'progress' && updater.progress.contentLength
    ? Math.min(100, Math.round((updater.progress.downloadedBytes / updater.progress.contentLength) * 100))
    : null;

  return (
    <div className="space-y-6">
      <SectionHeader title={t('preferences.general.title')} />

      <FieldRow
        title={t('preferences.general.language.title')}
        controlId="preferences-language"
      >
        <Select
          value={language}
          onValueChange={(value) => updateSettings({ language: value as AppLanguage })}
        >
          <SelectTrigger id="preferences-language" className="w-40">
            <span>{currentLanguageLabel}</span>
          </SelectTrigger>
          <SelectContent className="flowix-preferences-select-content">
            {LANGUAGE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>

      {isDesktop && (
        <>
          <FieldRow
            title={t('preferences.general.windowClose.title')}
            description={t('preferences.general.windowClose.description')}
            controlId="preferences-window-close"
          >
            <Select value={windowCloseAction} onValueChange={handleCloseActionChange}>
              <SelectTrigger id="preferences-window-close" className="w-40">
                <span>
                  {t(
                    windowCloseAction === 'exit'
                      ? 'preferences.general.windowClose.exit'
                      : 'preferences.general.windowClose.minimize',
                  )}
                </span>
              </SelectTrigger>
              <SelectContent className="flowix-preferences-select-content">
                <SelectItem value="minimize">
                  {t('preferences.general.windowClose.minimize')}
                </SelectItem>
                <SelectItem value="exit">{t('preferences.general.windowClose.exit')}</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>

          <FieldRow
            title={t('preferences.general.autostart.title')}
            description={t('preferences.general.autostart.description')}
            controlId="preferences-autostart"
          >
            <Select
              value={autostartState === 'on' ? 'on' : 'off'}
              onValueChange={(value) => void handleToggleAutostart(value)}
              disabled={autostartState === 'loading'}
            >
              <SelectTrigger id="preferences-autostart" className="w-40">
                <span>
                  {t(
                    autostartState === 'on'
                      ? 'preferences.general.autostart.on'
                      : 'preferences.general.autostart.off',
                  )}
                </span>
              </SelectTrigger>
              <SelectContent className="flowix-preferences-select-content">
                <SelectItem value="on">{t('preferences.general.autostart.on')}</SelectItem>
                <SelectItem value="off">{t('preferences.general.autostart.off')}</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>
        </>
      )}

      {afterGeneral}

      <SectionHeader title={t('preferences.general.about')} />

      <FieldRow title={t('preferences.general.currentVersion')}>
        <div className="flex min-w-0 items-center gap-1">
          <span
            className="max-w-[420px] truncate text-right text-sm text-[var(--muted-foreground)]"
            title={currentVersionText}
          >
            {currentVersionText}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 w-6 shrink-0 p-0"
            aria-label={versionCopied ? t('preferences.general.versionCopied') : t('preferences.general.copyVersion')}
            title={versionCopied ? t('preferences.general.versionCopied') : t('preferences.general.copyVersion')}
            disabled={!productInfo}
            onClick={() => void handleCopyVersion()}
          >
            {versionCopied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </Button>
        </div>
      </FieldRow>

      <FieldRow
        title={t('preferences.general.productUpdates.title')}
      >
        <Button
          variant="outline"
          className="px-3"
          onClick={handleCheckProductUpdates}
          disabled={checkingUpdates || updatingProduct}
        >
          {checkingUpdates
            ? t('preferences.general.productUpdates.checking')
            : t('preferences.general.productUpdates.check')}
        </Button>
      </FieldRow>

      {updater.update && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className={FIELD_TITLE_CLASS}>{t('appUpdates.available')}</div>
              {updater.update.body && (
                <p className="mt-1 line-clamp-3 whitespace-pre-line text-sm leading-5 text-[var(--muted-foreground)]">
                  {updater.update.body}
                </p>
              )}
              <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                {t('productUpdates.version', { version: updater.update.version })}
              </p>
              {updatingProduct && updater.progress && (
                <UpdateProgress
                  className="mt-3"
                  value={{
                    percent: downloadPercent,
                    downloadedBytes: updater.progress.phase === 'progress' ? updater.progress.downloadedBytes : undefined,
                    totalBytes: updater.progress.phase === 'progress' ? updater.progress.contentLength : undefined,
                  }}
                  label={t(downloadingUpdate ? 'appUpdates.downloading' : 'appUpdates.installing')}
                />
              )}
            </div>
            <Button variant="outline" size="sm" onClick={handleInstallUpdate} disabled={updatingProduct}>
              {downloadingUpdate ? t('appUpdates.downloading') : installingUpdate ? t('appUpdates.installing') : t('appUpdates.install')}
            </Button>
          </div>
        </div>
      )}

    </div>
  );
}
