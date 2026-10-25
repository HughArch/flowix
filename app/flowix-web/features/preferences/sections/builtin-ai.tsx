'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
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
import { builtinAi, type BuiltinAiConfigView } from '@platform/tauri/client';
import { SectionHeader, Field, FieldRow } from '@features/preferences/sections/primitives';

const SECTION_LABEL = 'text-xs font-medium uppercase tracking-wider text-[var(--muted-foreground)]';

/**
 * 内置 AI 助手（移动端 builtin agent）的独立配置分区。
 *
 * 表单值即真源：测试连接 / 获取模型都把当前表单值传给后端（空 Key 回落
 * 已存密钥），先填先测，不依赖失焦自动保存的时序。输入框失焦仍会静默
 * 持久化，保存动作本身保持无感。
 */
export function BuiltinAiSection() {
  const { t } = useI18n();
  const [config, setConfig] = useState<BuiltinAiConfigView | null>(null);
  const [apiUrl, setApiUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelOptions, setModelOptions] = useState<string[]>([]);

  useEffect(() => {
    let disposed = false;
    void builtinAi.getConfig()
      .then((view) => {
        if (disposed) return;
        setConfig(view);
        setApiUrl(view.apiUrl);
        setModel(view.model);
      })
      .catch((error) => toast.error(errorMessage(error)));
    return () => { disposed = true; };
  }, []);

  // 表单三要素是否齐全（Key 可以用已存密钥兜底）。
  const formComplete = Boolean(
    apiUrl.trim() && model.trim() && (apiKey.trim() || config?.hasApiKey),
  );

  const save = useCallback(async (patch: {
    enabled?: boolean;
    apiUrl?: string;
    apiKey?: string | null;
    model?: string;
    webSearchEnabled?: boolean;
  }) => {
    setBusy(true);
    try {
      const view = await builtinAi.setConfig({
        enabled: patch.enabled ?? config?.enabled ?? false,
        apiUrl: patch.apiUrl ?? apiUrl,
        apiKey: patch.apiKey !== undefined ? patch.apiKey : null,
        model: patch.model ?? model,
        webSearchEnabled: patch.webSearchEnabled ?? config?.webSearchEnabled ?? false,
      });
      setConfig(view);
      setApiUrl(view.apiUrl);
      setModel(view.model);
      // 保存成功后清空明文输入框，避免已保存的密钥看起来像没保存。
      if (patch.apiKey !== undefined && patch.apiKey !== '') setApiKey('');
      toast.success(t('preferences.builtinAi.saved'));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }, [config?.enabled, apiUrl, model, t]);

  const testConnection = useCallback(async () => {
    setTesting(true);
    try {
      const message = await builtinAi.testConnection({
        apiUrl,
        apiKey: apiKey.trim() || undefined,
        model,
      });
      toast.success(message);
      // 顺手把当前表单值持久化，省一步失焦保存。
      await save({});
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setTesting(false);
    }
  }, [apiUrl, apiKey, model, save]);

  const fetchModels = useCallback(async () => {
    setFetchingModels(true);
    try {
      const models = await builtinAi.listModels({
        apiUrl,
        apiKey: apiKey.trim() || undefined,
      });
      setModelOptions(models);
      toast.success(t('preferences.builtinAi.modelsFetched', { count: models.length }));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setFetchingModels(false);
    }
  }, [apiUrl, apiKey, t]);

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
          checked={config?.enabled ?? false}
          onChange={(event) => void save({ enabled: event.target.checked })}
        />
      </FieldRow>

      <section className="space-y-4">
        <h3 className={SECTION_LABEL}>{t('preferences.builtinAi.sectionProvider')}</h3>

        <Field title={t('preferences.builtinAi.apiUrl')} controlId="builtin-ai-api-url">
          <Input
            id="builtin-ai-api-url"
            value={apiUrl}
            placeholder={t('preferences.builtinAi.apiUrlPlaceholder')}
            onChange={(event) => setApiUrl(event.target.value)}
            onBlur={() => {
              if (apiUrl !== (config?.apiUrl ?? '')) void save({ apiUrl });
            }}
          />
        </Field>

        <Field
          title={t('preferences.builtinAi.apiKey')}
          controlId="builtin-ai-api-key"
          hint={config?.hasApiKey ? t('preferences.builtinAi.apiKeyStored') : undefined}
        >
          <Input
            id="builtin-ai-api-key"
            type="password"
            value={apiKey}
            placeholder={config?.hasApiKey
              ? t('preferences.builtinAi.apiKeyPlaceholderStored')
              : t('preferences.builtinAi.apiKeyPlaceholder')}
            onChange={(event) => setApiKey(event.target.value)}
            onBlur={() => {
              if (apiKey !== '') void save({ apiKey });
            }}
          />
        </Field>

        <Field
          title={t('preferences.builtinAi.model')}
          controlId="builtin-ai-model"
          hint={t('preferences.builtinAi.modelHint')}
        >
          <div className="flex w-full items-center gap-2">
            <Input
              id="builtin-ai-model"
              value={model}
              placeholder={t('preferences.builtinAi.modelPlaceholder')}
              className="min-w-0 flex-1"
              onChange={(event) => setModel(event.target.value)}
              onBlur={() => {
                if (model !== (config?.model ?? '')) void save({ model });
              }}
            />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0 px-2"
                  disabled={modelOptions.length === 0}
                  aria-label={t('preferences.builtinAi.chooseModel')}
                >
                  <ChevronDown className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-64 w-64 overflow-y-auto">
                <DropdownMenuLabel>{t('preferences.builtinAi.chooseModel')}</DropdownMenuLabel>
                {modelOptions.map((option) => (
                  <DropdownMenuItem
                    key={option}
                    onClick={() => {
                      setModel(option);
                      void save({ model: option });
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">{option}</span>
                    {option === model && (
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
              disabled={fetchingModels || !apiUrl.trim() || !(apiKey.trim() || config?.hasApiKey)}
              onClick={() => void fetchModels()}
            >
              {fetchingModels ? t('preferences.builtinAi.fetchingModels') : t('preferences.builtinAi.fetchModels')}
            </Button>
          </div>
        </Field>

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
            checked={config?.webSearchEnabled ?? false}
            onChange={(event) => void save({ webSearchEnabled: event.target.checked })}
          />
        </FieldRow>

        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            disabled={testing || busy || !formComplete}
            onClick={() => void testConnection()}
          >
            {testing ? t('preferences.builtinAi.testing') : t('preferences.builtinAi.test')}
          </Button>
          <span
            className={
              config?.configured
                ? 'rounded-full bg-[var(--success,#22c55e)]/10 px-2 py-0.5 text-xs text-[var(--success,#22c55e)]'
                : 'rounded-full bg-[var(--muted)] px-2 py-0.5 text-xs text-[var(--muted-foreground)]'
            }
          >
            {config?.configured
              ? t('preferences.builtinAi.configured')
              : t('preferences.builtinAi.notConfigured')}
          </span>
        </div>
      </section>
    </div>
  );
}

export default BuiltinAiSection;
