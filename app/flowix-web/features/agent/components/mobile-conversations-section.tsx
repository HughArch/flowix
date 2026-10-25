'use client';

import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { MessageSquare, Plus, Trash2 } from 'lucide-react';
import { Button } from '@shared/ui/button';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { errorMessage } from '@/lib/error-message';
import {
  agent,
  type AgentConversationInstance,
} from '@platform/tauri/client';
import { createAndOpenAgentConversation } from '@features/agent/public/shell-api';
import { openWorkspaceSurface } from '@features/workspace/public/open-surface-api';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import { isMobileDevice } from '@shared/platform';

/**
 * 左侧边栏的全局对话入口（移动端）：列出与文档无关联的独立会话
 * （source.kind === 'dedicated'），点击在工作区打开，可删除。
 * 文档关联的会话（thread-card source）不在这里出现 —— 它们跟随文档，
 * 从右侧 AI 侧边栏进入。
 */

function formatTime(timestamp: number, language: string): string {
  return new Intl.DateTimeFormat(language === 'zh-CN' ? 'zh-CN' : 'en-US', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

export function MobileConversationsSection() {
  const { t, language } = useI18n();
  const [conversations, setConversations] = useState<AgentConversationInstance[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const all = await agent.listConversationInstances();
      setConversations(
        all
          .filter((instance) => instance.source.kind === 'dedicated')
          .sort((a, b) => b.updatedAt - a.updatedAt),
      );
    } catch (error) {
      // 列表加载失败不打断笔记列表；打开面板时会再次尝试。
      console.warn('[mobile-conversations] list failed:', errorMessage(error));
    }
  }, []);

  useEffect(() => {
    if (!isMobileDevice()) return;
    void refresh();
    // 会话在别处（新建菜单 / 右侧面板）变动后刷新；流式 chunk 会高频更新
    // session store，用轻量签名（数量 + 最新更新时间）过滤掉无关变更。
    let signature = '';
    const unsubscribe = useAgentSessionStore.subscribe((state) => {
      const instances = Object.values(state.conversationRegistry.instances);
      const next = instances.length > 0
        ? `${instances.length}:${Math.max(...instances.map((item) => item.updatedAt))}`
        : '0';
      if (next === signature) return;
      signature = next;
      void refresh();
    });
    return unsubscribe;
  }, [refresh]);

  const handleOpen = useCallback((instance: AgentConversationInstance) => {
    void openWorkspaceSurface({
      target: { kind: 'agent-conversation', instanceId: instance.instanceId, blankIfMissing: true },
    });
  }, []);

  const handleCreate = useCallback(() => {
    createAndOpenAgentConversation('flowix', null);
  }, []);

  const handleDelete = useCallback(async (instance: AgentConversationInstance) => {
    setBusy(true);
    try {
      // 有线程的会话连线程（消息记录）一起删；没发过消息的只有 instance 行。
      if (instance.threadId) {
        await invoke<boolean>('agent_builtin_delete_thread', { threadId: instance.threadId });
        useAgentSessionStore.getState().removeInstancesForThreadAndWait(instance.threadId);
      } else {
        await agent.deleteConversationInstance(instance.instanceId);
        useAgentSessionStore.getState().removeInstance(instance.instanceId);
      }
      setConversations((previous) =>
        previous.filter((item) => item.instanceId !== instance.instanceId),
      );
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }, []);

  if (!isMobileDevice()) return null;

  return (
    <section className="border-b border-[var(--border)] px-2 py-1.5">
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1 text-left text-xs font-medium text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          <MessageSquare className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{t('memo.create.conversations')}</span>
          {conversations.length > 0 && (
            <span className="shrink-0 text-[10px] tabular-nums opacity-70">{conversations.length}</span>
          )}
        </button>
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6 shrink-0 rounded-md"
          aria-label={t('agent.mobilePanel.newConversation')}
          onClick={handleCreate}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
      {expanded && (
        <ul className="mt-1 space-y-0.5">
          {conversations.length === 0 && (
            <li className="px-2 py-1.5 text-xs text-[var(--muted-foreground)]">
              {t('agent.mobilePanel.emptyConversations')}
            </li>
          )}
          {conversations.map((instance) => (
            <li key={instance.instanceId} className="group flex items-center gap-1">
              <button
                type="button"
                disabled={busy}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[var(--muted)] disabled:opacity-50"
                onClick={() => handleOpen(instance)}
              >
                <span className="min-w-0 flex-1 truncate text-xs text-[var(--foreground)]">
                  {instance.threadTitle || t('agent.mobilePanel.untitledConversation')}
                </span>
                <span className="shrink-0 text-[10px] tabular-nums text-[var(--muted-foreground)]">
                  {formatTime(instance.updatedAt, language)}
                </span>
              </button>
              <button
                type="button"
                disabled={busy}
                className="shrink-0 rounded-md p-1.5 text-[var(--muted-foreground)] opacity-0 transition-opacity hover:bg-[var(--muted)] hover:text-[var(--destructive)] focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-50"
                aria-label={t('agent.mobilePanel.deleteConversation')}
                onClick={() => void handleDelete(instance)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default MobileConversationsSection;
