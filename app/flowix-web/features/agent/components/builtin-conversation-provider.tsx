'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { formatModelDisplayLabel } from '@features/agent/config/codex-options';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import type { AgentConversationInstance } from '@features/agent/store/agent-conversation-types';
import {
  builtinAi,
  type BuiltinAiProviderView,
} from '@platform/tauri/client';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@shared/ui/dropdown-menu';
import { useI18n } from '@/lib/i18n';

/**
 * 内置助手会话的模型配置选择：composer 里的「模型 · 配置名」chip + 绑定逻辑。
 *
 * 配置按会话实例绑定（runtimeConfig.builtinProviderId）；新会话默认跟随
 * 设置里的全局活跃配置。笔记级侧边栏（MobileAgentPanel）和左侧面板新建
 * 对话的 workspace surface（AgentConversationRenderer）共用这一份，保证
 * 两处入口的选择行为与样式一致。
 */

/** 与桌面 composer 模型 chip 同一套展示文案：`模型 · 配置名`。 */
function providerDisplayText(provider: BuiltinAiProviderView | null): {
  model: string;
  name: string;
  text: string;
} {
  const model = provider?.model ? formatModelDisplayLabel(provider.model) : '';
  const name = provider?.name || provider?.apiUrl || '';
  return {
    model,
    name,
    text: model && name ? `${model} · ${name}` : model || name,
  };
}

/**
 * 模型 chip rendered inside the composer actions row, next to +.
 *
 * 复用桌面外部 Agent 的 `.agent-composer__model` 系列 class，视觉与桌面
 * composer 模型按钮完全一致（依赖 `.agent-composer--expanded` 作用域下的
 * 样式，两个入口的 composer 都是 expanded variant）。
 */
export function ConversationProviderSelector({
  providers,
  providerId,
  onChange,
}: {
  providers: BuiltinAiProviderView[];
  providerId: string;
  onChange: (providerId: string) => void;
}) {
  const { t } = useI18n();
  if (providers.length === 0) return null;
  const current = providers.find((provider) => provider.id === providerId) ?? null;
  const display = providerDisplayText(current);
  const label = display.text || t('agent.mobilePanel.noProvider');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="agent-composer__model"
          title={`${t('agent.model.title')}: ${label}`}
          aria-label={`${t('agent.model.title')}: ${label}`}
        >
          <span className="agent-composer__model-value">
            <span className="agent-composer__model-name">
              {display.model || display.name || t('agent.mobilePanel.noProvider')}
            </span>
            {display.model && display.name && (
              <span className="agent-composer__model-effort">· {display.name}</span>
            )}
          </span>
          <ChevronDown className="agent-conversation__control-chevron" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {providers.map((provider) => (
          <DropdownMenuItem key={provider.id} onClick={() => onChange(provider.id)}>
            <span className="min-w-0 flex-1 truncate">
              {providerDisplayText(provider).text || provider.id}
            </span>
            {provider.id === providerId && (
              <Check className="ml-2 h-3.5 w-3.5 shrink-0 text-[var(--brand)]" />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Provider list + per-conversation binding for one builtin conversation.
 *
 * Config is (re)loaded when `enabled`/`reloadKey` changes: the note-level
 * drawer passes `enabled: open` so settings edited while it was closed are
 * picked up on reopen; the workspace surface passes nothing and refreshes on
 * mount.
 */
export function useBuiltinConversationProvider(
  instance: AgentConversationInstance | null,
  options: { enabled?: boolean; reloadKey?: string | number | boolean } = {},
) {
  const { enabled = true, reloadKey } = options;
  const [providers, setProviders] = useState<BuiltinAiProviderView[]>([]);
  const [activeProviderId, setActiveProviderId] = useState('');

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    void builtinAi.getConfig()
      .then((view) => {
        if (disposed) return;
        setProviders(view.providers);
        setActiveProviderId(view.activeProviderId);
      })
      .catch(() => {});
    return () => { disposed = true; };
  }, [enabled, reloadKey]);

  const boundProviderId = instance?.runtimeConfig?.builtinProviderId;
  // A missing/deleted provider falls back to the global active provider.
  const providerId = (boundProviderId
    && providers.some((provider) => provider.id === boundProviderId)
    ? boundProviderId
    : activeProviderId) || '';

  // New conversations default to the global active provider; the choice is
  // persisted on the conversation instance, not globally.
  useEffect(() => {
    if (!enabled || !instance || !activeProviderId) return;
    if (boundProviderId && providers.some((provider) => provider.id === boundProviderId)) return;
    useAgentSessionStore.getState().upsertInstance(instance.instanceId, {
      runtimeConfig: {
        ...(instance.runtimeConfig ?? {}),
        builtinProviderId: activeProviderId,
      },
    });
  }, [activeProviderId, boundProviderId, enabled, instance, providers]);

  const setProvider = useCallback((providerId: string) => {
    if (!instance) return;
    useAgentSessionStore.getState().upsertInstance(instance.instanceId, {
      runtimeConfig: {
        ...(instance.runtimeConfig ?? {}),
        builtinProviderId: providerId,
      },
    });
  }, [instance]);

  return { providers, providerId, setProvider };
}
