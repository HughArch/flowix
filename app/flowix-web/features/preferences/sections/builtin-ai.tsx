'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, Plus, Trash2 } from 'lucide-react';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@shared/ui/dropdown-menu';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { errorMessage } from '@/lib/error-message';
import {
  builtinAi,
  type BuiltinAiConfigView,
  type BuiltinAiProviderView,
} from '@platform/tauri/client';
import { SectionHeader, Field, FieldRow } from '@features/preferences/sections/primitives';

const SECTION_LABEL = 'text-xs font-medium uppercase tracking-wider text-[var(--muted-foreground)]';

interface DraftProvider {
  /** Stable local key; persisted providers use their backend id. */
  key: string;
  id: string | null;
  name: string;
  apiUrl: string;
  /** Plaintext draft; empty means "keep the stored key". */
  apiKey: string;
  model: string;
  hasApiKey: boolean;
}

function toDraft(provider: BuiltinAiProviderView): DraftProvider {
  return {
    key: provider.id,
    id: provider.id,
    name: provider.name,
    apiUrl: provider.apiUrl,
    apiKey: '',
    model: provider.model,
    hasApiKey: provider.hasApiKey,
  };
}

function newDraft(): DraftProvider {
  return {
    key: `new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    id: null,
    name: '',
    apiUrl: '',
    apiKey: '',
    model: '',
    hasApiKey: false,
  };
}

/**
 * 内置 AI 助手（移动端 builtin agent）的独立配置分区。
 *
 * 支持多个厂商（provider）：每个厂商是独立的 API 地址 / Key / 模型；
 * 对话面板可随时切换当前厂商。所有修改先在本地草稿里，点「保存配置」落库；
 * API Key 留空表示保留已存密钥。
 */
export function BuiltinAiSection() {
  const { t } = useI18n();
  const [config, setConfig] = useState<BuiltinAiConfigView | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [activeProviderId, setActiveProviderId] = useState('');
  const [providers, setProviders] = useState<DraftProvider[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testingKey, setTestingKey] = useState<string | null>(null);
  const [fetchingKey, setFetchingKey] = useState<string | null>(null);
  const [modelOptions, setModelOptions] = useState<Record<string, string[]>>({});

  const applyView = useCallback((view: BuiltinAiConfigView) => {
    setConfig(view);
    setEnabled(view.enabled);
    setWebSearchEnabled(view.webSearchEnabled);
    setActiveProviderId(view.activeProviderId);
    setProviders(view.providers.map(toDraft));
    setDirty(false);
  }, []);

  useEffect(() => {
    let disposed = false;
    void builtinAi.getConfig()
      .then((view) => {
        if (!disposed) applyView(view);
      })
      .catch((error) => toast.error(errorMessage(error)));
    return () => { disposed = true; };
  }, [applyView]);

  const updateProvider = useCallback((key: string, patch: Partial<DraftProvider>) => {
    setProviders((previous) =>
      previous.map((provider) => (provider.key === key ? { ...provider, ...patch } : provider)),
    );
    setDirty(true);
  }, []);

  const addProvider = useCallback(() => {
    setProviders((previous) => [...previous, newDraft()]);
    setDirty(true);
  }, []);

  const removeProvider = useCallback((key: string) => {
    setProviders((previous) => {
      const next = previous.filter((provider) => provider.key !== key);
      const removed = previous.find((provider) => provider.key === key);
      if (removed?.id && removed.id === activeProviderId) {
        setActiveProviderId(next.find((provider) => provider.id)?.id ?? '');
      }
      return next;
    });
    setDirty(true);
  }, [activeProviderId]);

  const save = useCallback(async () => {
    setBusy(true);
    try {
      const view = await builtinAi.setConfig({
        enabled,
        maxTotalTokens: config?.maxTotalTokens,
        webSearchEnabled,
        activeProviderId,
        providers: providers.map((provider) => ({
          id: provider.id,
          name: provider.name,
          apiUrl: provider.apiUrl,
          apiKey: provider.apiKey.trim() ? provider.apiKey : null,
          model: provider.model,
        })),
      });
      applyView(view);
      toast.success(t('preferences.builtinAi.saved'));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }, [activeProviderId, applyView, config?.maxTotalTokens, enabled, providers, t, webSearchEnabled]);

  const setActive = useCallback((providerId: string) => {
    setActiveProviderId(providerId);
    setDirty(true);
  }, []);

  const providerOverride = useCallback((provider: DraftProvider) => ({
    apiUrl: provider.apiUrl,
    apiKey: provider.apiKey.trim() || undefined,
    model: provider.model,
  }), []);

  const testConnection = useCallback(async (provider: DraftProvider) => {
    setTestingKey(provider.key);
    try {
      const message = await builtinAi.testConnection(providerOverride(provider));
      toast.success(message);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setTestingKey(null);
    }
  }, [providerOverride]);

  const fetchModels = useCallback(async (provider: DraftProvider) => {
    setFetchingKey(provider.key);
    try {
      const models = await builtinAi.listModels({
        apiUrl: provider.apiUrl,
        apiKey: provider.apiKey.trim() || undefined,
      });
      setModelOptions((previous) => ({ ...previous, [provider.key]: models }));
      toast.success(t('preferences.builtinAi.modelsFetched', { count: models.length }));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setFetchingKey(null);
    }
  }, [t]);

  const activeProvider = useMemo(
    () => providers.find((provider) => provider.id && provider.id === activeProviderId) ?? null,
    [activeProviderId, providers],
  );

  return (
    <div className="space-y-7 pb-8">
      <SectionHeader
        title={t('preferences.builtinAi.title')}
        description={t('preferences.builtinAi.description')}
      />

      <FieldRow
        title={t('preferences.builtinAi.enabled')}
        description={t('preferences.builtinAi.enabledHint')}
        controlId="builtin-ai-enabled"
      >
        <input
          id="builtin-ai-enabled"
          type="checkbox"
          className="h-4 w-4 accent-[var(--brand)]"
          disabled={busy || !config}
          checked={enabled}
          onChange={(event) => {
            setEnabled(event.target.checked);
            setDirty(true);
          }}
        />
      </FieldRow>

      <FieldRow
        title={t('preferences.builtinAi.webSearch')}
        description={t('preferences.builtinAi.webSearchHint')}
        controlId="builtin-ai-web-search"
      >
        <input
          id="builtin-ai-web-search"
          type="checkbox"
          className="h-4 w-4 accent-[var(--brand)]"
          disabled={busy || !config}
          checked={webSearchEnabled}
          onChange={(event) => {
            setWebSearchEnabled(event.target.checked);
            setDirty(true);
          }}
        />
      </FieldRow>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className={SECTION_LABEL}>{t('preferences.builtinAi.providerSection')}</h3>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={addProvider} disabled={busy}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              {t('preferences.builtinAi.addProvider')}
            </Button>
            <Button type="button" size="sm" onClick={() => void save()} disabled={busy || !dirty}>
              {busy ? t('preferences.builtinAi.saving') : t('preferences.builtinAi.saveConfig')}
            </Button>
          </div>
        </div>

        {providers.length === 0 && (
          <p className="rounded-lg border border-dashed border-[var(--border)] px-3 py-4 text-xs text-[var(--muted-foreground)]">
            {t('preferences.builtinAi.noProviders')}
          </p>
        )}

        {providers.map((provider) => {
          const options = modelOptions[provider.key] ?? [];
          const isActive = !!provider.id && provider.id === activeProviderId;
          return (
            <div
              key={provider.key}
              className={`space-y-3 rounded-lg border p-3 ${
                isActive ? 'border-[var(--brand)]' : 'border-[var(--border)]'
              }`}
            >
              <div className="flex items-center gap-2">
                <Input
                  value={provider.name}
                  placeholder={t('preferences.builtinAi.providerNamePlaceholder')}
                  className="max-w-[180px]"
                  onChange={(event) => updateProvider(provider.key, { name: event.target.value })}
                />
                {isActive ? (
                  <span className="rounded-full bg-[var(--brand)]/10 px-2 py-0.5 text-[11px] text-[var(--brand)]">
                    {t('preferences.builtinAi.activeProvider')}
                  </span>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!provider.id || busy}
                    onClick={() => provider.id && setActive(provider.id)}
                  >
                    {t('preferences.builtinAi.setActiveProvider')}
                  </Button>
                )}
                <div className="flex-1" />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-[var(--destructive)]"
                  disabled={busy}
                  onClick={() => removeProvider(provider.key)}
                  aria-label={t('preferences.builtinAi.removeProvider')}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>

              <Field title={t('preferences.builtinAi.apiUrl')} controlId={`builtin-ai-url-${provider.key}`}>
                <Input
                  id={`builtin-ai-url-${provider.key}`}
                  value={provider.apiUrl}
                  placeholder={t('preferences.builtinAi.apiUrlPlaceholder')}
                  onChange={(event) => updateProvider(provider.key, { apiUrl: event.target.value })}
                />
              </Field>

              <Field
                title={t('preferences.builtinAi.apiKey')}
                controlId={`builtin-ai-key-${provider.key}`}
                hint={provider.hasApiKey ? t('preferences.builtinAi.apiKeyStored') : undefined}
              >
                <Input
                  id={`builtin-ai-key-${provider.key}`}
                  type="password"
                  value={provider.apiKey}
                  placeholder={provider.hasApiKey
                    ? t('preferences.builtinAi.apiKeyPlaceholderStored')
                    : t('preferences.builtinAi.apiKeyPlaceholder')}
                  onChange={(event) => updateProvider(provider.key, { apiKey: event.target.value })}
                />
              </Field>

              <Field
                title={t('preferences.builtinAi.model')}
                controlId={`builtin-ai-model-${provider.key}`}
                hint={t('preferences.builtinAi.modelHint')}
              >
                <div className="flex w-full items-center gap-2">
                  <Input
                    id={`builtin-ai-model-${provider.key}`}
                    value={provider.model}
                    placeholder={t('preferences.builtinAi.modelPlaceholder')}
                    className="min-w-0 flex-1"
                    onChange={(event) => updateProvider(provider.key, { model: event.target.value })}
                  />
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="shrink-0 px-2"
                        disabled={options.length === 0}
                        aria-label={t('preferences.builtinAi.chooseModel')}
                      >
                        <ChevronDown className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="max-h-64 w-64 overflow-y-auto">
                      <DropdownMenuLabel>{t('preferences.builtinAi.chooseModel')}</DropdownMenuLabel>
                      {options.map((option) => (
                        <DropdownMenuItem
                          key={option}
                          onClick={() => updateProvider(provider.key, { model: option })}
                        >
                          <span className="min-w-0 flex-1 truncate">{option}</span>
                          {option === provider.model && (
                            <Check className="ml-2 h-3.5 w-3.5 shrink-0 text-[var(--brand)]" />
                          )}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    disabled={fetchingKey === provider.key || !provider.apiUrl.trim()
                      || !(provider.apiKey.trim() || provider.hasApiKey)}
                    onClick={() => void fetchModels(provider)}
                  >
                    {fetchingKey === provider.key
                      ? t('preferences.builtinAi.fetchingModels')
                      : t('preferences.builtinAi.fetchModels')}
                  </Button>
                </div>
              </Field>

              <div className="flex items-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={testingKey === provider.key || !provider.apiUrl.trim()
                    || !(provider.apiKey.trim() || provider.hasApiKey) || !provider.model.trim()}
                  onClick={() => void testConnection(provider)}
                >
                  {testingKey === provider.key
                    ? t('preferences.builtinAi.testing')
                    : t('preferences.builtinAi.test')}
                </Button>
                <span className="text-xs text-[var(--muted-foreground)]">
                  {provider.id && provider.name.trim() ? provider.name : t('preferences.builtinAi.notConfigured')}
                </span>
              </div>
            </div>
          );
        })}

        {dirty && (
          <p className="text-xs text-[var(--muted-foreground)]">
            {t('preferences.builtinAi.unsaved')}
          </p>
        )}
        {activeProvider && (
          <p className="text-xs text-[var(--muted-foreground)]">
            {t('preferences.builtinAi.currentProvider', { name: activeProvider.name || activeProvider.apiUrl })}
          </p>
        )}
      </section>
    </div>
  );
}

export default BuiltinAiSection;
