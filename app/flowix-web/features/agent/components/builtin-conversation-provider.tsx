'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
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
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@shared/ui/dropdown-menu';
import { useI18n } from '@/lib/i18n';

/**
 * 内置助手会话的云厂商选择：composer 里的厂商 chip + 绑定逻辑。
 *
 * 厂商按会话实例绑定（runtimeConfig.builtinProviderId）；新会话默认跟随
 * 设置里的全局活跃厂商。笔记级侧边栏（MobileAgentPanel）和左侧面板新建
 * 对话的 workspace surface（AgentConversationRenderer）共用这一份，保证
 * 两处入口的厂商选择行为与样式一致。
 */

/** Provider chip rendered inside the composer actions row, next to +. */
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
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex h-6 max-w-[112px] items-center gap-1 rounded-md px-1.5 text-[11px] text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
          aria-label={t('agent.mobilePanel.provider')}
        >
          <span className="min-w-0 flex-1 truncate text-left">
            {current?.name || t('agent.mobilePanel.noProvider')}
          </span>
          <ChevronDown className="h-3 w-3 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuLabel>{t('agent.mobilePanel.provider')}</DropdownMenuLabel>
        {providers.map((provider) => (
          <DropdownMenuItem key={provider.id} onClick={() => onChange(provider.id)}>
            <span className="min-w-0 flex-1 truncate">
              {provider.name || provider.apiUrl}
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
