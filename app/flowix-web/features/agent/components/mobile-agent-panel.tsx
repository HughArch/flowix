'use client';

import { useCallback, useEffect } from 'react';
import { create } from 'zustand';
import { X } from 'lucide-react';
import { AgentConversationDetail } from '@features/agent/components/agent-conversation-detail';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import type { AgentConversationInstance } from '@features/agent/store/agent-conversation-types';
import { useDocumentStore } from '@features/document/store/document-store';
import { useNoteStore } from '@features/memo/store/note-store';
import { canonicalPath } from '@/lib/path';
import { useI18n } from '@/lib/i18n';
import { isMobileDevice } from '@shared/platform';

/**
 * 移动端右侧 AI 侧边栏：承载与「当前打开文档」关联的内置助手会话。
 *
 * - 会话以 `thread-card` source 绑定文档（documentPath + relativePath +
 *   notebookId），同一文档重复打开复用同一条会话；
 * - 文档被删除时，`main-window-notebook-events` 会按同样的匹配规则清除
 *   会话记录（thread + messages + instance）；
 * - 首次打开只创建 instance（threadId 为空），发出第一条消息才真正建线程。
 */

interface MobileAgentPanelState {
  open: boolean;
  instanceId: string | null;
  boundPath: string | null;
  openForCurrentDocument: () => void;
  close: () => void;
}

function resolveDocumentContext(path: string): {
  notebookId: string | null;
  relativePath: string | null;
} {
  const notebooks = useNoteStore.getState().notebooks;
  const normalized = canonicalPath(path);
  let owner: { id: string; path: string } | null = null;
  let ownerRootLength = -1;
  for (const notebook of notebooks) {
    const root = canonicalPath(notebook.path);
    const prefix = `${root}/`;
    if (normalized.startsWith(prefix) && root.length > ownerRootLength) {
      owner = notebook;
      ownerRootLength = root.length;
    }
  }
  if (!owner) return { notebookId: null, relativePath: null };
  return {
    notebookId: owner.id,
    relativePath: normalized.slice(ownerRootLength + 1) || null,
  };
}

function findDocumentConversation(path: string): AgentConversationInstance | null {
  const { notebookId, relativePath } = resolveDocumentContext(path);
  const instances = useAgentSessionStore.getState().conversationRegistry.instances;
  for (const instance of Object.values(instances)) {
    if (instance.agentType !== 'flowix') continue;
    if (instance.source.kind !== 'thread-card') continue;
    if (instance.source.documentPath === path) return instance;
    if (
      notebookId
      && relativePath
      && instance.source.notebookId === notebookId
      && instance.source.relativePath === relativePath
    ) {
      return instance;
    }
  }
  return null;
}

export const useMobileAgentPanelStore = create<MobileAgentPanelState>((set) => ({
  open: false,
  instanceId: null,
  boundPath: null,
  openForCurrentDocument: () => {
    const documentState = useDocumentStore.getState();
    const path = documentState.currentDocumentPath;
    if (!path) return;
    const existing = findDocumentConversation(path);
    if (existing) {
      set({ open: true, instanceId: existing.instanceId, boundPath: path });
      return;
    }
    const { notebookId, relativePath } = resolveDocumentContext(path);
    const instance = useAgentSessionStore.getState().createInstance({
      agentType: 'flowix',
      title: '',
      threadId: null,
      source: { kind: 'thread-card', documentPath: path, relativePath, notebookId },
      runtimeConfig: {
        notebookId: notebookId ?? undefined,
      },
    });
    set({ open: true, instanceId: instance.instanceId, boundPath: path });
  },
  close: () => set({ open: false }),
}));

/** Right-side AI drawer for the current document (mobile only). */
export function MobileAgentPanel() {
  const { t } = useI18n();
  const open = useMobileAgentPanelStore((state) => state.open);
  const instanceId = useMobileAgentPanelStore((state) => state.instanceId);
  const boundPath = useMobileAgentPanelStore((state) => state.boundPath);
  const close = useMobileAgentPanelStore((state) => state.close);

  const documentTitle = boundPath?.split(/[\\/]/).pop()?.replace(/\.md$/i, '') ?? '';

  // 追随文档切换：面板开着时切到另一篇文档，自动换绑到那篇文档的会话。
  useEffect(() => {
    if (!open) return;
    const unsubscribe = useDocumentStore.subscribe((state) => {
      const path = state.currentDocumentPath;
      if (!path || path === useMobileAgentPanelStore.getState().boundPath) return;
      const existing = findDocumentConversation(path);
      if (existing) {
        useMobileAgentPanelStore.setState({
          instanceId: existing.instanceId,
          boundPath: path,
        });
        return;
      }
      const { notebookId, relativePath } = resolveDocumentContext(path);
      const instance = useAgentSessionStore.getState().createInstance({
        agentType: 'flowix',
        title: '',
        threadId: null,
        source: { kind: 'thread-card', documentPath: path, relativePath, notebookId },
        runtimeConfig: { notebookId: notebookId ?? undefined },
      });
      useMobileAgentPanelStore.setState({
        instanceId: instance.instanceId,
        boundPath: path,
      });
    });
    return unsubscribe;
  }, [open]);

  const onOpenChange = useCallback((next: boolean) => {
    if (!next) close();
  }, [close]);

  if (!isMobileDevice()) return null;

  return (
    <>
      {/* 遮罩 + 抽屉跟随 sync panel 的覆盖层模式；打开时才挂载 detail。 */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/40"
          onClick={() => onOpenChange(false)}
          aria-hidden="true"
        />
      )}
      <aside
        role="dialog"
        aria-label={t('agent.mobilePanel.title')}
        className={`fixed right-0 top-0 z-50 flex h-full w-[min(92vw,420px)] flex-col border-l border-[var(--border)] bg-[var(--card)] shadow-2xl transition-transform duration-200 ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border)] px-3">
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--foreground)]">
            {documentTitle || t('agent.mobilePanel.title')}
          </span>
          <button
            type="button"
            onClick={close}
            className="rounded-md p-1 text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
            aria-label={t('common.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1">
          {open && instanceId && (
            <AgentConversationDetail instanceId={instanceId} />
          )}
        </div>
      </aside>
    </>
  );
}
