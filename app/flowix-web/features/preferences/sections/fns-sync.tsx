'use client';

import { useCallback, useEffect, useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { SectionHeader, Field, FieldRow } from '@features/preferences/sections/primitives';
import { Input } from '@shared/ui/input';
import { Button } from '@shared/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@shared/ui/select';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { errorMessage } from '@/lib/error-message';
import { fns, type FnsConfigPatch, type FnsConfigView, type FnsSyncStatus } from '@platform/tauri/client';

const SECTION_LABEL = 'text-xs font-medium uppercase tracking-wider text-[var(--muted-foreground)]';

export function FnsSyncSection() {
  const { t, language } = useI18n();
  const [config, setConfig] = useState<FnsConfigView | null>(null);
  const [status, setStatus] = useState<FnsSyncStatus | null>(null);
  const [api, setApi] = useState('');
  const [maxAttachmentMb, setMaxAttachmentMb] = useState('20');
  const [startupDelay, setStartupDelay] = useState('8');
  const [maxRetry, setMaxRetry] = useState('10');
  const [busy, setBusy] = useState(false);

  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [tokenLabel, setTokenLabel] = useState('');
  const [tokenValue, setTokenValue] = useState('');

  const load = useCallback(async () => {
    const [nextConfig, nextStatus] = await Promise.all([fns.getConfig(), fns.getStatus()]);
    setConfig(nextConfig);
    setStatus(nextStatus);
    setApi(nextConfig.api);
    setMaxAttachmentMb(String(Math.round(nextConfig.maxAttachmentBytes / (1024 * 1024))));
    setStartupDelay(String(nextConfig.startupSyncDelaySeconds));
    setMaxRetry(String(nextConfig.maxRetryAttempts));
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
    setFormOpen(false);
    setEditingId(null);
    setTokenLabel('');
    setTokenValue('');
  }, []);

  const saveToken = useCallback(async () => {
    if (!tokenLabel.trim() || (!editingId && !tokenValue.trim())) return;
    setBusy(true);
    try {
      setConfig(await fns.upsertToken({
        id: editingId ?? undefined,
        label: tokenLabel,
        token: tokenValue,
      }));
      resetTokenForm();
      toast.success(t('preferences.fns.saved'));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }, [editingId, resetTokenForm, t, tokenLabel, tokenValue]);

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
    <div className="space-y-7 pb-8">
      <SectionHeader title={t('preferences.fns.title')} description={t('preferences.fns.description')} />

      <FieldRow title={t('preferences.fns.enabled')} description={t('preferences.fns.enabledHint')} controlId="fns-enabled">
        <input
          id="fns-enabled"
          type="checkbox"
          className="h-4 w-4 accent-[var(--brand)]"
          disabled={busy || !config}
          checked={config?.enabled ?? false}
          onChange={(event) => void saveGlobal({ enabled: event.target.checked })}
        />
      </FieldRow>

      <section className="space-y-4">
        <h3 className={SECTION_LABEL}>{t('preferences.fns.sectionConnection')}</h3>

        <Field title={t('preferences.fns.api')} controlId="fns-api">
          <Input
            id="fns-api"
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
          <Input
            id="fns-max-attachment"
            type="number"
            min={0}
            step={1}
            className="w-32"
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

        <Field
          title={t('preferences.fns.startupDelay')}
          controlId="fns-startup-delay"
          hint={t('preferences.fns.startupDelayHint')}
        >
          <Input
            id="fns-startup-delay"
            type="number"
            min={0}
            step={1}
            className="w-32"
            value={startupDelay}
            onChange={(event) => setStartupDelay(event.target.value)}
            onBlur={() => {
              const seconds = Number(startupDelay);
              if (!Number.isFinite(seconds) || seconds < 0) return;
              if (seconds !== config?.startupSyncDelaySeconds) {
                void saveGlobal({ startupSyncDelaySeconds: Math.round(seconds) });
              }
            }}
          />
        </Field>

        <Field
          title={t('preferences.fns.maxRetry')}
          controlId="fns-max-retry"
          hint={t('preferences.fns.maxRetryHint')}
        >
          <Input
            id="fns-max-retry"
            type="number"
            min={0}
            step={1}
            className="w-32"
            value={maxRetry}
            onChange={(event) => setMaxRetry(event.target.value)}
            onBlur={() => {
              const attempts = Number(maxRetry);
              if (!Number.isFinite(attempts) || attempts < 0) return;
              if (attempts !== config?.maxRetryAttempts) {
                void saveGlobal({ maxRetryAttempts: Math.round(attempts) });
              }
            }}
          />
        </Field>

        <Field
          title={t('preferences.fns.conflictStrategy')}
          controlId="fns-conflict-strategy"
          hint={t('preferences.fns.conflictStrategyHint')}
        >
          <Select
            value={config?.offlineSyncStrategy ?? 'newTimeMerge'}
            disabled={busy || !config}
            onValueChange={(value) => {
              if (value === 'newTimeMerge' || value === 'ignoreTimeMerge') {
                void saveGlobal({ offlineSyncStrategy: value });
              }
            }}
          >
            <SelectTrigger id="fns-conflict-strategy" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newTimeMerge">{t('preferences.fns.strategyNewTime')}</SelectItem>
              <SelectItem value="ignoreTimeMerge">{t('preferences.fns.strategyIgnoreTime')}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className={SECTION_LABEL}>{t('preferences.fns.tokens')}</h3>
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 rounded-lg px-2.5"
            disabled={busy}
            onClick={() => {
              setEditingId(null);
              setTokenLabel('');
              setTokenValue('');
              setFormOpen(true);
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            {t('preferences.fns.addToken')}
          </Button>
        </div>
        <p className="text-xs text-[var(--muted-foreground)]">{t('preferences.fns.tokensHint')}</p>

        {(config?.tokens.length ?? 0) === 0 && !formOpen && (
          <div className="rounded-xl border border-dashed border-[var(--border)] px-4 py-6 text-center text-sm text-[var(--muted-foreground)]">
            {t('preferences.fns.noTokens')}
          </div>
        )}

        <div className="space-y-2">
          {config?.tokens.map((token) => (
            <div
              key={token.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 py-2.5"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-[var(--foreground)]">{token.label}</div>
                <div className="text-xs text-[var(--muted-foreground)]">
                  {token.hasToken ? t('preferences.fns.tokenConfigured') : t('preferences.fns.tokenMissing')}
                </div>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 rounded-lg p-0"
                  aria-label={t('preferences.fns.editToken')}
                  title={t('preferences.fns.editToken')}
                  disabled={busy}
                  onClick={() => {
                    setEditingId(token.id);
                    setTokenLabel(token.label);
                    setTokenValue('');
                    setFormOpen(true);
                  }}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 rounded-lg p-0 text-[var(--destructive)]"
                  aria-label={t('preferences.fns.deleteToken')}
                  title={t('preferences.fns.deleteToken')}
                  disabled={busy}
                  onClick={() => void removeToken(token.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>

        {formOpen && (
          <div className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
            <div className="text-sm font-medium text-[var(--foreground)]">
              {editingId ? t('preferences.fns.editToken') : t('preferences.fns.addToken')}
            </div>
            <Input
              value={tokenLabel}
              placeholder={t('preferences.fns.tokenLabel')}
              onChange={(event) => setTokenLabel(event.target.value)}
            />
            <Input
              type="password"
              value={tokenValue}
              placeholder={t('preferences.fns.tokenPlaceholder')}
              onChange={(event) => setTokenValue(event.target.value)}
            />
            <div className="flex justify-end gap-2 pt-1">
              <Button size="sm" variant="ghost" className="rounded-lg" onClick={resetTokenForm}>
                {t('preferences.fns.cancel')}
              </Button>
              <Button
                size="sm"
                className="rounded-lg"
                disabled={busy || !tokenLabel.trim() || (!editingId && !tokenValue.trim())}
                onClick={() => void saveToken()}
              >
                {t('preferences.fns.save')}
              </Button>
            </div>
          </div>
        )}
      </section>

      <section className="flex items-center justify-between gap-4 rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 py-3">
        <div className="min-w-0 space-y-0.5">
          <div className="text-sm text-[var(--foreground)]">
            {status?.running ? t('preferences.fns.running') : t('preferences.fns.lastSync')}
          </div>
          <div className="text-xs text-[var(--muted-foreground)]">
            {status?.running ? '' : lastSync}
            {status?.lastError ? ` · ${status.lastError}` : ''}
            {!config?.configured ? ` · ${t('preferences.fns.notConfigured')}` : ''}
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="shrink-0 rounded-lg"
          disabled={busy || !config?.configured}
          onClick={() => void syncNow()}
        >
          {t('preferences.fns.syncAll')}
        </Button>
      </section>
    </div>
  );
}
