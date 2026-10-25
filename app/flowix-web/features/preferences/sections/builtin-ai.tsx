'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { errorMessage } from '@/lib/error-message';
import { builtinAi, type BuiltinAiConfigView } from '@platform/tauri/client';
import { SectionHeader, Field, FieldRow } from '@features/preferences/sections/primitives';

const SECTION_LABEL = 'text-xs font-medium uppercase tracking-wider text-[var(--muted-foreground)]';

/**
 * 内置 AI 助手（移动端 builtin agent）的独立配置分区。
 *
 * 与桌面外部 Agent 的配置分区（pi / dsh / aiAgent / mcp）互不相干：
 * 这里只管理进程内助手的 OpenAI-compatible provider 三要素。
 */
export function BuiltinAiSection() {
  const { t } = useI18n();
  const [config, setConfig] = useState<BuiltinAiConfigView | null>(null);
  const [apiUrl, setApiUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);

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

  const save = useCallback(async (patch: {
    enabled?: boolean;
    apiUrl?: string;
    apiKey?: string | null;
    model?: string;
  }) => {
    setBusy(true);
    try {
      const view = await builtinAi.setConfig({
        enabled: patch.enabled ?? config?.enabled ?? false,
        apiUrl: patch.apiUrl ?? apiUrl,
        apiKey: patch.apiKey !== undefined ? patch.apiKey : null,
        model: patch.model ?? model,
      });
      setConfig(view);
      setApiUrl(view.apiUrl);
      setModel(view.model);
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
      const message = await builtinAi.testConnection();
      toast.success(message);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setTesting(false);
    }
  }, []);

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

        <Field title={t('preferences.builtinAi.model')} controlId="builtin-ai-model">
          <Input
            id="builtin-ai-model"
            value={model}
            placeholder={t('preferences.builtinAi.modelPlaceholder')}
            onChange={(event) => setModel(event.target.value)}
            onBlur={() => {
              if (model !== (config?.model ?? '')) void save({ model });
            }}
          />
        </Field>

        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            disabled={testing || busy || !config?.hasApiKey}
            onClick={() => void testConnection()}
          >
            {testing ? t('preferences.builtinAi.testing') : t('preferences.builtinAi.test')}
          </Button>
          <span className="text-xs text-[var(--muted-foreground)]">
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
