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
  const [maxAttachmentMb, setMaxAttachmentMb] = useState('20');
  const [busy, setBusy] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [tokenLabel, setTokenLabel] = useState('');
  const [tokenValue, setTokenValue] = useState('');
  // No default: the value must match the token's `c:` scope dimension, and
  // guessing wrong only surfaces as a 315 at sync time.
  const [tokenClientType, setTokenClientType] = useState('');

  const load = useCallback(async () => {
    const [nextConfig, nextStatus] = await Promise.all([fns.getConfig(), fns.getStatus()]);
    setConfig(nextConfig);
    setStatus(nextStatus);
    setApi(nextConfig.api);
    setMaxAttachmentMb(String(Math.round(nextConfig.maxAttachmentBytes / (1024 * 1024))));
  }, []);

  useEffect(() => {
    void load().catch((error) => toast.error(errorMessage(error)));
  }, [load]);

  useEffect(() => {
    if (!config?.configured) return;
    const timer = setInterval(() => {
      void fns.getStatus().then(setStatus).catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [config?.configured]);

  const saveGlobal = useCallback(async (patch: FnsConfigPatch) => {
    setBusy(true);
    try {
      const next = await fns.patchConfig(patch);
      setConfig(next);
      setApi(next.api);
      toast.success(t('preferences.fns.saved'));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }, [t]);

  const resetTokenForm = useCallback(() => {
    setEditingId(null);
    setTokenLabel('');
    setTokenValue('');
    setTokenClientType('');
  }, []);

  const saveToken = useCallback(async () => {
    if (!tokenLabel.trim() || !tokenClientType || (!editingId && !tokenValue.trim())) return;
    setBusy(true);
    try {
      const next = await fns.upsertToken({
        id: editingId ?? undefined,
        label: tokenLabel,
        token: tokenValue,
        clientType: tokenClientType,
      });
      setConfig(next);
      resetTokenForm();
      toast.success(t('preferences.fns.saved'));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }, [editingId, resetTokenForm, t, tokenClientType, tokenLabel, tokenValue]);

  const removeToken = useCallback(async (id: string) => {
    setBusy(true);
    try {
      setConfig(await fns.deleteToken(id));
      if (editingId === id) resetTokenForm();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }, [editingId, resetTokenForm]);

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
          onChange={(event) => void saveGlobal({ enabled: event.target.checked })}
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
            if (api !== (config?.api ?? '')) void saveGlobal({ api });
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
              void saveGlobal({ maxAttachmentBytes: bytes });
            }
          }}
        />
      </Field>

      <div className="space-y-2 border-t border-[var(--divider)] pt-4">
        <span className="text-sm text-[var(--foreground)]">{t('preferences.fns.tokens')}</span>
        <p className="text-sm text-[var(--muted-foreground)]">{t('preferences.fns.tokensHint')}</p>

        {(config?.tokens.length ?? 0) === 0 && (
          <p className="py-2 text-sm text-[var(--muted-foreground)]">{t('preferences.fns.noTokens')}</p>
        )}

        {config?.tokens.map((token) => (
          <div
            key={token.id}
            className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] px-3 py-2"
          >
            <div className="min-w-0">
              <div className="truncate text-sm text-[var(--foreground)]">{token.label}</div>
              <div className="text-xs text-[var(--muted-foreground)]">
                {token.clientType}
                {token.hasToken ? ` · ${t('preferences.fns.tokenConfigured')}` : ''}
              </div>
            </div>
            <div className="flex shrink-0 gap-1">
              <Button
                size="sm"
                variant="ghost"
                className="h-7 rounded-lg px-2"
                disabled={busy}
                onClick={() => {
                  setEditingId(token.id);
                  setTokenLabel(token.label);
                  setTokenValue('');
                  setTokenClientType(token.clientType);
                }}
              >
                {t('preferences.fns.editToken')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 rounded-lg px-2 text-[var(--destructive)]"
                disabled={busy}
                onClick={() => void removeToken(token.id)}
              >
                {t('preferences.fns.deleteToken')}
              </Button>
            </div>
          </div>
        ))}

        <div className="space-y-2 rounded-lg border border-[var(--border)] p-3">
          <div className="text-sm text-[var(--foreground)]">
            {editingId ? t('preferences.fns.editToken') : t('preferences.fns.addToken')}
          </div>
          <input
            className={FIELD_INPUT_CLASS}
            value={tokenLabel}
            placeholder={t('preferences.fns.tokenLabel')}
            onChange={(event) => setTokenLabel(event.target.value)}
          />
          <input
            className={FIELD_INPUT_CLASS}
            type="password"
            value={tokenValue}
            placeholder={t('preferences.fns.tokenPlaceholder')}
            onChange={(event) => setTokenValue(event.target.value)}
          />
          <select
            className={FIELD_INPUT_CLASS}
            value={tokenClientType}
            onChange={(event) => setTokenClientType(event.target.value)}
          >
            <option value="">{t('preferences.fns.clientTypePlaceholder')}</option>
            <option value="obsidianPlugin">{t('preferences.fns.clientTypeObsidian')}</option>
            <option value="flowix">{t('preferences.fns.clientTypeFlowix')}</option>
          </select>
          <p className="text-xs text-[var(--muted-foreground)]">{t('preferences.fns.clientTypeHint')}</p>
          <div className="flex gap-2">
            <Button
              size="sm"
              className="rounded-lg"
              disabled={busy || !tokenLabel.trim() || !tokenClientType || (!editingId && !tokenValue.trim())}
              onClick={() => void saveToken()}
            >
              {t('preferences.fns.save')}
            </Button>
            {editingId && (
              <Button size="sm" variant="outline" className="rounded-lg" onClick={resetTokenForm}>
                {t('preferences.fns.cancel')}
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 border-t border-[var(--divider)] pt-4">
        <div className="space-y-0.5">
          <span className="text-sm text-[var(--foreground)]">{t('preferences.fns.status')}</span>
          <p className="text-sm text-[var(--muted-foreground)]">
            {status?.running ? t('preferences.fns.running') : `${t('preferences.fns.lastSync')}: ${lastSync}`}
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
          {t('preferences.fns.syncAll')}
        </Button>
      </div>
    </div>
  );
}
