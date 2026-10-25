'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { Check, ChevronDown, Pencil, Plus, X } from 'lucide-react';
import { AgentConversationDetail } from '@features/agent/components/agent-conversation-detail';
import { ConversationRenameDialog } from '@features/agent/components/conversation-rename-dialog';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import type { AgentConversationInstance } from '@features/agent/store/agent-conversation-types';
import { useDocumentStore } from '@features/document/store/document-store';
import { useNoteStore } from '@features/memo/store/note-store';
import { canonicalPath } from '@/lib/path';
import { displayTitleFromFilename } from '@/lib/utils';
import { buildNoteOpenLink } from '@platform/open-target/path-link';
import { escapeMarkdownLinkText } from '@features/editor/extensions/note-link/note-reference-markdown';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@shared/ui/dropdown-menu';
import { useI18n } from '@/lib/i18n';
import { isMobileDevice } from '@shared/platform';

/**
 * 移动端右侧 AI 侧边栏：承载与「当前打开文档」关联的内置助手会话。
 *
 * - 一篇文档可以有多条会话；打开抽屉时自动选中该文档最近的一条，
 *   也可以从标题栏下拉切换或新建。
 * - 会话以 `thread-card` source 绑定文档（documentPath + relativePath +
 *   notebookId）；文档被删除时 `main-window-notebook-events` 会按同样的
 *   匹配规则清除这些会话（thread + messages + instance）。
 * - 首次打开只创建 instance（threadId 为空），发出第一条消息才真正建线程；
 *   空会话不落库，发过消息后才会持久化。新建空会话时会在输入框里预置
 *   当前文档的 @ 引用。
 */

const DETAIL_DRAFT_KEY_PREFIX = 'flowix:agent-conversation-draft:';

interface MobileAgentPanelState {
  open: boolean;
  instanceId: string | null;
  boundPath: string | null;
  /** Open the drawer for the current document. Returns false when no document is open. */
  openForCurrentDocument: () => Promise<boolean>;
  newConversation: () => Promise<boolean>;
  selectConversation: (instanceId: string) => void;
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

function matchesDocument(instance: AgentConversationInstance, path: string): boolean {
  if (instance.agentType !== 'flowix' || instance.source.kind !== 'thread-card') return false;
  if (instance.source.documentPath === path) return true;
  const { notebookId, relativePath } = resolveDocumentContext(path);
  return !!notebookId
    && !!relativePath
    && instance.source.notebookId === notebookId
    && instance.source.relativePath === relativePath;
}

/** All built-in conversations bound to one document, newest first. */
export function listDocumentConversations(path: string): AgentConversationInstance[] {
  const instances = useAgentSessionStore.getState().conversationRegistry.instances;
  return Object.values(instances)
    .filter((instance) => matchesDocument(instance, path))
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

function isBlankConversation(instance: AgentConversationInstance): boolean {
  return !instance.threadId && !instance.title.trim();
}

/**
 * Seed a fresh conversation's composer with a @reference to the document it
 * is bound to. `AgentConversationDetail` reads this draft on mount and its
 * Tiptap composer parses the markdown link into a note-reference card.
 */
function seedDocumentReference(instanceId: string, path: string): void {
  try {
    const key = `${DETAIL_DRAFT_KEY_PREFIX}${instanceId}`;
    if (window.localStorage.getItem(key)) return;
    const { notebookId, relativePath } = resolveDocumentContext(path);
    if (!notebookId || !relativePath) return;
    const notebook = useNoteStore.getState().notebooks.find((item) => item.id === notebookId);
    if (!notebook?.name) return;
    const title = escapeMarkdownLinkText(displayTitleFromFilename(relativePath));
    const target = buildNoteOpenLink(notebook.name, relativePath);
    window.localStorage.setItem(key, `[${title}](${target})`);
  } catch {
    // Draft seeding is a convenience; blocked storage must not break the drawer.
  }
}

function createDocumentConversation(path: string): AgentConversationInstance {
  const { notebookId, relativePath } = resolveDocumentContext(path);
  const instance = useAgentSessionStore.getState().createInstance({
    agentType: 'flowix',
    title: '',
    threadId: null,
    source: { kind: 'thread-card', documentPath: path, relativePath, notebookId },
    runtimeConfig: { notebookId: notebookId ?? undefined },
  });
  seedDocumentReference(instance.instanceId, path);
  return instance;
}

/** Pick the conversation a freshly opened drawer should show for `path`. */
function resolveConversationFor(path: string): AgentConversationInstance {
  const existing = listDocumentConversations(path);
  // Prefer a conversation that actually has content; reuse a single blank
  // one rather than accumulating empty instances.
  const withContent = existing.find((instance) => !isBlankConversation(instance));
  if (withContent) return withContent;
  const blank = existing.find(isBlankConversation);
  if (blank) {
    seedDocumentReference(blank.instanceId, path);
    return blank;
  }
  return createDocumentConversation(path);
}

export const useMobileAgentPanelStore = create<MobileAgentPanelState>((set) => ({
  open: false,
  instanceId: null,
  boundPath: null,
  openForCurrentDocument: async () => {
    const path = useDocumentStore.getState().currentDocumentPath;
    if (!path) return false;
    // Persisted instances are not hydrated at startup; pull them before
    // matching so a reopened app selects the document's existing conversation
    // instead of minting a fresh one.
    await useAgentSessionStore.getState().hydrateFromBackend();
    const instance = resolveConversationFor(path);
    set({ open: true, instanceId: instance.instanceId, boundPath: path });
    return true;
  },
  newConversation: async () => {
    const path = useMobileAgentPanelStore.getState().boundPath
      ?? useDocumentStore.getState().currentDocumentPath;
    if (!path) return false;
    await useAgentSessionStore.getState().hydrateFromBackend();
    const blank = listDocumentConversations(path).find(isBlankConversation);
    const instance = blank ?? createDocumentConversation(path);
    if (blank) seedDocumentReference(blank.instanceId, path);
    set({ open: true, instanceId: instance.instanceId, boundPath: path });
    return true;
  },
  selectConversation: (instanceId) => set({ instanceId, open: true }),
  close: () => set({ open: false }),
}));

/** Right-side AI drawer for the current document (mobile only). */
export function MobileAgentPanel() {
  const { t } = useI18n();
  const open = useMobileAgentPanelStore((state) => state.open);
  const instanceId = useMobileAgentPanelStore((state) => state.instanceId);
  const boundPath = useMobileAgentPanelStore((state) => state.boundPath);
  const close = useMobileAgentPanelStore((state) => state.close);
  const selectConversation = useMobileAgentPanelStore((state) => state.selectConversation);
  const newConversation = useMobileAgentPanelStore((state) => state.newConversation);
  const [renameOpen, setRenameOpen] = useState(false);

  // Subscribe to the registry so the switcher updates as titles arrive.
  const instances = useAgentSessionStore((state) => state.conversationRegistry.instances);
  const conversations = useMemo(
    () => boundPath
      ? Object.values(instances)
        .filter((instance) => matchesDocument(instance, boundPath))
        .sort((left, right) => right.updatedAt - left.updatedAt)
      : [],
    [instances, boundPath],
  );
  const current = conversations.find((instance) => instance.instanceId === instanceId) ?? null;
  const currentTitle = current?.title.trim() || t('agent.mobilePanel.untitledConversation');

  // 追随文档切换：面板开着时切到另一篇文档，自动选中那篇文档的会话。
  useEffect(() => {
    if (!open) return;
    return useDocumentStore.subscribe((state) => {
      const path = state.currentDocumentPath;
      if (!path || path === useMobileAgentPanelStore.getState().boundPath) return;
      const instance = resolveConversationFor(path);
      useMobileAgentPanelStore.setState({
        instanceId: instance.instanceId,
        boundPath: path,
      });
    });
  }, [open]);

  const onOpenChange = useCallback((next: boolean) => {
    if (!next) close();
  }, [close]);

  if (!isMobileDevice()) return null;

  return (
    <>
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
        <header className="flex h-11 shrink-0 items-center gap-1.5 border-b border-[var(--border)] px-2">
          <span className="shrink-0 text-xs font-semibold text-[var(--foreground)]">
            {t('agent.mobilePanel.title')}
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1 text-xs text-[var(--foreground)] hover:bg-[var(--muted)]"
                aria-label={t('agent.mobilePanel.selectConversation')}
              >
                <span className="min-w-0 flex-1 truncate text-left">{currentTitle}</span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-72 w-64 overflow-y-auto">
              <DropdownMenuLabel>{t('agent.mobilePanel.conversations')}</DropdownMenuLabel>
              {conversations.length === 0 && (
                <DropdownMenuItem disabled>
                  {t('agent.mobilePanel.emptyConversations')}
                </DropdownMenuItem>
              )}
              {conversations.map((instance) => (
                <DropdownMenuItem
                  key={instance.instanceId}
                  onClick={() => selectConversation(instance.instanceId)}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {instance.title.trim() || t('agent.mobilePanel.untitledConversation')}
                  </span>
                  {instance.instanceId === instanceId && (
                    <Check className="ml-2 h-3.5 w-3.5 shrink-0 text-[var(--brand)]" />
                  )}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => void newConversation()}>
                <Plus className="mr-2 h-3.5 w-3.5" />
                {t('agent.mobilePanel.newConversation')}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!current} onClick={() => setRenameOpen(true)}>
                <Pencil className="mr-2 h-3.5 w-3.5" />
                {t('agent.mobilePanel.renameConversation')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            type="button"
            disabled={!current}
            onClick={() => setRenameOpen(true)}
            className="shrink-0 rounded-md p-1 text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-40"
            aria-label={t('agent.mobilePanel.renameConversation')}
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => void newConversation()}
            className="shrink-0 rounded-md p-1 text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
            aria-label={t('agent.mobilePanel.newConversation')}
          >
            <Plus className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={close}
            className="shrink-0 rounded-md p-1 text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
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
      <ConversationRenameDialog
        open={renameOpen}
        initialTitle={current?.title ?? ''}
        onOpenChange={setRenameOpen}
        onSubmit={(title) => {
          if (!current) return;
          void useAgentSessionStore.getState().renameAgentConversation({
            instanceId: current.instanceId,
            threadId: current.threadId,
            title,
            typeKey: 'flowix',
          });
        }}
      />
    </>
  );
}
