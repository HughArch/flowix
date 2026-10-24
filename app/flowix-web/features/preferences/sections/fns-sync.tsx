'use client';

import { useCallback, useEffect, useState } from 'react';
import { SectionHeader, Field, FieldRow, FIELD_INPUT_CLASS } from '@features/preferences/sections/primitives';
import { Button } from '@shared/ui/button';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { errorMessage } from '@/lib/error-message';
import { fns, type FnsConfigPatch, type FnsConfigView, type FnsSyncStatus } from '@platform/tauri/client';
import { useNoteStore } from '@features/memo/store/note-store';

export function FnsSyncSection() {
  const { t, language } = useI18n();
  const selectedNotebookId = useNoteStore((state) => state.selectedNotebookId);
  const [config, setConfig] = useState<FnsConfigView | null>(null);
  const [status, setStatus] = useState<FnsSyncStatus | null>(null);
  const [api, setApi] = useState('');
  const [token, setToken] = useState('');
  const [clientType, setClientType] = useState('flowix');
  const [maxAttachmentMb, setMaxAttachmentMb] = useState('20');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [nextConfig, nextStatus] = await Promise.all([fns.getConfig(), fns.getStatus()]);
    setConfig(nextConfig);
    setStatus(nextStatus);
    setApi(nextConfig.api);
    setClientType(nextConfig.clientType);
    setMaxAttachmentMb(String(Math.round(nextConfig.maxAttachmentBytes / (1024 * 1024))));
  }, []);

  useEffect(() => {
    void load().catch((error) => toast.error(errorMessage(error)));
  }, [load]);

  // Keep the status (including retry countdown) fresh while the page is open.
  useEffect(() => {
    if (!config?.configured) return;
    const timer = setInterval(() => {
      void fns.getStatus().then(setStatus).catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [config?.configured]);

  const save = useCallback(async (patch: FnsConfigPatch) => {
    setBusy(true);
    try {
      const next = await fns.patchConfig(patch);
      setConfig(next);
      setApi(next.api);
      setClientType(next.clientType);
      setToken('');
      toast.success(t('preferences.fns.saved'));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }, [t]);

  const syncCurrent = useCallback(async () => {
    if (!selectedNotebookId) return;
    setBusy(true);
    try {
      const outcome = await fns.syncNotebook(selectedNotebookId);
      setStatus(await fns.getStatus());
      if (outcome) {
        toast.success(
          `${t('preferences.fns.syncDone')} · ${outcome.vault} ↓${outcome.pulled} ↑${outcome.pushed} · ${t('preferences.fns.attachments')} ↓${outcome.filesPulled} ↑${outcome.filesPushed}`,
        );
      }
    } catch (error) {
      toast.error(`${t('preferences.fns.syncFailed')}: ${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  }, [selectedNotebookId, t]);

  const syncNow = useCallback(async () => {
    setBusy(true);
    try {
      const outcomes = await fns.syncAll();
      const pulled = outcomes.reduce((sum, item) => sum + item.pulled, 0);
      const pushed = outcomes.reduce((sum, item) => sum + item.pushed, 0);
      const filesPulled = outcomes.reduce((sum, item) => sum + item.filesPulled, 0);
      const filesPushed = outcomes.reduce((sum, item) => sum + item.filesPushed, 0);
      setStatus(await fns.getStatus());
      toast.success(
        `${t('preferences.fns.syncDone')} · ↓${pulled} ↑${pushed} · ${t('preferences.fns.attachments')} ↓${filesPulled} ↑${filesPushed}`,
      );
    } catch (error) {
      toast.error(`${t('preferences.fns.syncFailed')}: ${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  }, [t]);

  const lastSync = status?.lastSyncAt
    ? new Intl.DateTimeFormat(language === 'zh-CN' ? 'zh-CN' : 'en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(status.lastSyncAt))
    : t('preferences.fns.never');

  const retryAt = status?.nextRetryAt
    ? new Intl.DateTimeFormat(language === 'zh-CN' ? 'zh-CN' : 'en-US', {
        timeStyle: 'medium',
      }).format(new Date(status.nextRetryAt))
    : null;

  return (
    <div className="space-y-5 pb-6">
      <SectionHeader title={t('preferences.fns.title')} description={t('preferences.fns.description')} />

      <FieldRow title={t('preferences.fns.enabled')} controlId="fns-enabled">
        <input
          id="fns-enabled"
          type="checkbox"
          disabled={busy || !config}
          checked={config?.enabled ?? false}
          onChange={(event) => void save({ enabled: event.target.checked })}
        />
      </FieldRow>

      <Field title={t('preferences.fns.api')} controlId="fns-api">
        <input
          id="fns-api"
          className={FIELD_INPUT_CLASS}
          value={api}
          placeholder={t('preferences.fns.apiPlaceholder')}
          onChange={(event) => setApi(event.target.value)}
          onBlur={() => {
            if (api !== (config?.api ?? '')) void save({ api });
          }}
        />
      </Field>

      <Field
        title={t('preferences.fns.token')}
        controlId="fns-token"
        hint={config?.hasToken ? t('preferences.fns.tokenConfigured') : undefined}
      >
        <input
          id="fns-token"
          type="password"
          className={FIELD_INPUT_CLASS}
          value={token}
          placeholder={t('preferences.fns.tokenPlaceholder')}
          onChange={(event) => setToken(event.target.value)}
          onBlur={() => {
            if (token.trim()) void save({ token });
          }}
        />
      </Field>

      <Field
        title={t('preferences.fns.clientType')}
        controlId="fns-client-type"
        hint={t('preferences.fns.clientTypeHint')}
      >
        <input
          id="fns-client-type"
          className={FIELD_INPUT_CLASS}
          value={clientType}
          onChange={(event) => setClientType(event.target.value)}
          onBlur={() => {
            if (clientType !== (config?.clientType ?? '')) void save({ clientType });
          }}
        />
      </Field>

      <Field
        title={t('preferences.fns.maxAttachment')}
        controlId="fns-max-attachment"
        hint={t('preferences.fns.maxAttachmentHint')}
      >
        <input
          id="fns-max-attachment"
          type="number"
          min={0}
          step={1}
          className={FIELD_INPUT_CLASS}
          value={maxAttachmentMb}
          onChange={(event) => setMaxAttachmentMb(event.target.value)}
          onBlur={() => {
            const megabytes = Number(maxAttachmentMb);
            if (!Number.isFinite(megabytes) || megabytes < 0) return;
            const bytes = Math.round(megabytes * 1024 * 1024);
            if (bytes !== config?.maxAttachmentBytes) {
              void save({ maxAttachmentBytes: bytes });
            }
          }}
        />
      </Field>

      <div className="flex items-center justify-between gap-4 border-t border-[var(--divider)] pt-4">
        <div className="space-y-0.5">
          <span className="text-sm text-[var(--foreground)]">{t('preferences.fns.status')}</span>
          <p className="text-sm text-[var(--muted-foreground)]">
            {status?.running
              ? t('preferences.fns.running')
              : `${t('preferences.fns.lastSync')}: ${lastSync}`}
            {retryAt ? ` · ${t('preferences.fns.retryScheduled')} ${retryAt}` : ''}
            {status?.lastError ? ` · ${status.lastError}` : ''}
            {!config?.configured ? ` · ${t('preferences.fns.notConfigured')}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            disabled={busy || !config?.configured || !selectedNotebookId}
            onClick={() => void syncCurrent()}
          >
            {t('preferences.fns.syncCurrent')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !config?.configured}
            onClick={() => void syncNow()}
          >
            {t('preferences.fns.syncAll')}
          </Button>
        </div>
      </div>
    </div>
  );
}
