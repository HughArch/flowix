'use client';

import { useCallback, useEffect, useState } from 'react';
import { SectionHeader, Field, FieldRow, FIELD_INPUT_CLASS } from '@features/preferences/sections/primitives';
import { Button } from '@shared/ui/button';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { errorMessage } from '@/lib/error-message';
import { fns, type FnsConfigPatch, type FnsConfigView, type FnsSyncStatus } from '@platform/tauri/client';

export function FnsSyncSection() {
  const { t, language } = useI18n();
  const [config, setConfig] = useState<FnsConfigView | null>(null);
  const [status, setStatus] = useState<FnsSyncStatus | null>(null);
  const [api, setApi] = useState('');
  const [token, setToken] = useState('');
  const [clientType, setClientType] = useState('flowix');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [nextConfig, nextStatus] = await Promise.all([fns.getConfig(), fns.getStatus()]);
    setConfig(nextConfig);
    setStatus(nextStatus);
    setApi(nextConfig.api);
    setClientType(nextConfig.clientType);
  }, []);

  useEffect(() => {
    void load().catch((error) => toast.error(errorMessage(error)));
  }, [load]);

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

  const syncNow = useCallback(async () => {
    setBusy(true);
    try {
      const outcomes = await fns.syncAll();
      const pulled = outcomes.reduce((sum, item) => sum + item.pulled, 0);
      const pushed = outcomes.reduce((sum, item) => sum + item.pushed, 0);
      setStatus(await fns.getStatus());
      toast.success(`${t('preferences.fns.syncDone')} · ↓${pulled} ↑${pushed}`);
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

      <div className="flex items-center justify-between gap-4 border-t border-[var(--divider)] pt-4">
        <div className="space-y-0.5">
          <span className="text-sm text-[var(--foreground)]">{t('preferences.fns.status')}</span>
          <p className="text-sm text-[var(--muted-foreground)]">
            {status?.running
              ? t('preferences.fns.running')
              : `${t('preferences.fns.lastSync')}: ${lastSync}`}
            {status?.lastError ? ` · ${status.lastError}` : ''}
            {!config?.configured ? ` · ${t('preferences.fns.notConfigured')}` : ''}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !config?.configured}
          onClick={() => void syncNow()}
        >
          {t('preferences.fns.syncNow')}
        </Button>
      </div>
    </div>
  );
}
