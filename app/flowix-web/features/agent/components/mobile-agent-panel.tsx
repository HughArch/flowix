'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { Plus, X } from 'lucide-react';
import { AgentConversationDetail } from '@features/agent/components/agent-conversation-detail';
import {
  ConversationProviderSelector,
  useBuiltinConversationProvider,
} from '@features/agent/components/builtin-conversation-provider';
import { ConversationRenameDialog } from '@features/agent/components/conversation-rename-dialog';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import type { AgentConversationInstance } from '@features/agent/store/agent-conversation-types';
import { useDocumentStore } from '@features/document/store/document-store';
import { useNoteStore } from '@features/memo/store/note-store';
import { canonicalPath } from '@/lib/path';
import { displayTitleFromFilename } from '@/lib/utils';
import { buildNoteOpenLink } from '@platform/open-target/path-link';
import { escapeMarkdownLinkText } from '@features/editor/extensions/note-link/note-reference-markdown';
import { Button } from '@shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@shared/ui/dialog';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { errorMessage } from '@/lib/error-message';
import { isMobileDevice } from '@shared/platform';

/**
 * 移动端右侧 AI 侧边栏。
 *
 * - 会话以标签页呈现（仅当前文档）；关闭标签即删除该对话记录，
 *   长按标签弹出重命名/删除菜单。
 * - 支持在同一文档下新建多条会话；首次新建的空会话会在输入框里
 *   预置当前文档的 @ 引用。
 * - 标题栏右侧可切换当前 AI 厂商；切换后下一条消息生效。
 */

const DETAIL_DRAFT_KEY_PREFIX = 'flowix:agent-conversation-draft:';

interface MobileAgentPanelState {
  open: boolean;
  instanceId: string | null;
  boundPath: string | null;
  openForCurrentDocument: () => Promise<boolean>;
  newConversation: () => Promise<boolean>;
  selectConversation: (instanceId: string) => void;
  close: () => void;
}

function resolveDocumentContext(path: string): {
  notebookId: string | null;
  relativePath: string | null;
} {
  const documentState = useDocumentStore.getState();
  const notebooks = useNoteStore.getState().notebooks;
  // Prefer the open session's identity: Android notebook roots may not
  // prefix-match document paths verbatim (symlinked /data/data spellings),
  // and the session carries what was chosen at open time.
  const session = documentState.activeExternalSession;
  if (
    session?.notebookId
    && session.relativePath
    && documentState.currentDocumentPath
    && canonicalPath(documentState.currentDocumentPath) === canonicalPath(path)
  ) {
    return { notebookId: session.notebookId, relativePath: session.relativePath };
  }
  const normalized = canonicalPath(path);
  let owner: { id: string; path: string } | null = null;
  let ownerRootLength = -1;
  for (const notebook of notebooks) {
    // Android reports notebook roots with a trailing slash; strip it or the
    // `root + '/'` prefix can never match.
    const root = canonicalPath(notebook.path).replace(/\/+$/, '');
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

/** One conversation tab. Long-press (touch) / right-click opens the tab menu. */
function ConversationTab({
  instance,
  active,
  title,
  onSelect,
  onClose,
  onLongPress,
}: {
  instance: AgentConversationInstance;
  active: boolean;
  title: string;
  onSelect: (instance: AgentConversationInstance) => void;
  onClose: (instance: AgentConversationInstance) => void;
  onLongPress: (instance: AgentConversationInstance, x: number, y: number) => void;
}) {
  const timerRef = useRef<number | null>(null);
  const longPressedRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startLongPress = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    longPressedRef.current = false;
    clearTimer();
    const { clientX, clientY } = event;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      longPressedRef.current = true;
      onLongPress(instance, clientX, clientY);
    }, 500);
  }, [clearTimer, instance, onLongPress]);

  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={0}
      onPointerDown={startLongPress}
      onPointerUp={clearTimer}
      onPointerLeave={clearTimer}
      onPointerCancel={clearTimer}
      onContextMenu={(event) => {
        event.preventDefault();
        onLongPress(instance, event.clientX, event.clientY);
      }}
      onClick={() => {
        if (longPressedRef.current) {
          longPressedRef.current = false;
          return;
        }
        onSelect(instance);
      }}
      className={`flex h-7 max-w-[160px] shrink-0 cursor-pointer items-center gap-1 rounded-md border px-2 text-xs transition-colors ${
        active
          ? 'border-[var(--brand)] bg-[var(--brand)]/10 text-[var(--brand)]'
          : 'border-[var(--border)] text-[var(--muted-foreground)] hover:bg-[var(--muted)]'
      }`}
    >
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <button
        type="button"
        className="shrink-0 rounded p-0.5 hover:bg-black/10"
        aria-label={`关闭 ${title}`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onClose(instance);
        }}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

export function MobileAgentPanel() {
  const { t } = useI18n();
  const open = useMobileAgentPanelStore((state) => state.open);
  const instanceId = useMobileAgentPanelStore((state) => state.instanceId);
  const boundPath = useMobileAgentPanelStore((state) => state.boundPath);
  const close = useMobileAgentPanelStore((state) => state.close);
  const selectConversation = useMobileAgentPanelStore((state) => state.selectConversation);
  const newConversation = useMobileAgentPanelStore((state) => state.newConversation);
  const [renameTarget, setRenameTarget] = useState<AgentConversationInstance | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AgentConversationInstance | null>(null);
  const [tabMenu, setTabMenu] = useState<{ instance: AgentConversationInstance; x: number; y: number } | null>(null);

  const instances = useAgentSessionStore((state) => state.conversationRegistry.instances);
  const conversations = useMemo(
    () => boundPath
      ? Object.values(instances)
        .filter((instance) => matchesDocument(instance, boundPath))
        .sort((left, right) => right.updatedAt - left.updatedAt)
      : [],
    [instances, boundPath],
  );
  const currentInstance = conversations.find((instance) => instance.instanceId === instanceId) ?? null;
  // Provider is bound per conversation; logic shared with the left-panel
  // conversation surface. `reloadKey: open` re-reads the config each time the
  // drawer opens (settings may have changed while it was closed).
  const providerControl = useBuiltinConversationProvider(currentInstance, { enabled: open, reloadKey: open });

  useEffect(() => {
    if (!open) {
      setTabMenu(null);
      return;
    }
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

  const deleteConversation = useCallback(async (instance: AgentConversationInstance) => {
    try {
      if (instance.threadId) {
        await invoke<boolean>('agent_builtin_delete_thread', { threadId: instance.threadId });
        await useAgentSessionStore.getState().removeInstancesForThreadAndWait(instance.threadId);
      } else {
        await builtinAiDeleteBlank(instance.instanceId);
        useAgentSessionStore.getState().removeInstance(instance.instanceId);
      }
      const state = useMobileAgentPanelStore.getState();
      if (state.instanceId === instance.instanceId) {
        const remaining = listDocumentConversations(state.boundPath ?? '')
          .filter((item) => item.instanceId !== instance.instanceId);
        useMobileAgentPanelStore.setState({ instanceId: remaining[0]?.instanceId ?? null });
      }
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }, []);

  const requestDelete = useCallback((instance: AgentConversationInstance) => {
    if (instance.threadId) {
      setDeleteTarget(instance);
    } else {
      void deleteConversation(instance);
    }
  }, [deleteConversation]);

  const onCloseTab = useCallback((instance: AgentConversationInstance) => {
    setTabMenu(null);
    requestDelete(instance);
  }, [requestDelete]);

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
        className={`fixed right-0 top-0 z-50 flex h-full w-[min(92vw,440px)] flex-col border-l border-[var(--border)] bg-[var(--card)] shadow-2xl transition-transform duration-200 ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <header className="flex h-11 shrink-0 items-center gap-1.5 border-b border-[var(--border)] px-2">
          <span className="shrink-0 text-xs font-semibold text-[var(--foreground)]">
            {t('agent.mobilePanel.title')}
          </span>
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {conversations.map((instance) => (
              <ConversationTab
                key={instance.instanceId}
                instance={instance}
                active={instance.instanceId === instanceId}
                title={instance.title.trim() || t('agent.mobilePanel.untitledConversation')}
                onSelect={(target) => selectConversation(target.instanceId)}
                onClose={onCloseTab}
                onLongPress={(target, x, y) => setTabMenu({ instance: target, x, y })}
              />
            ))}
          </div>
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
          {open && instanceId ? (
            <AgentConversationDetail
              instanceId={instanceId}
              composerExtra={
                <ConversationProviderSelector
                  providers={providerControl.providers}
                  providerId={providerControl.providerId}
                  onChange={providerControl.setProvider}
                />
              }
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <p className="text-sm text-[var(--muted-foreground)]">
                {t('agent.mobilePanel.emptyConversations')}
              </p>
              <Button size="sm" onClick={() => void newConversation()}>
                <Plus className="mr-1 h-3.5 w-3.5" />
                {t('agent.mobilePanel.newConversation')}
              </Button>
            </div>
          )}
        </div>
      </aside>

      {/* Long-press menu */}
      {tabMenu && (
        <>
          <div
            className="fixed inset-0 z-[60]"
            onClick={() => setTabMenu(null)}
            aria-hidden="true"
          />
          <div
            className="fixed z-[61] min-w-[140px] overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--card)] py-1 shadow-2xl"
            style={{
              left: Math.min(tabMenu.x, window.innerWidth - 160),
              top: Math.min(tabMenu.y, window.innerHeight - 120),
            }}
          >
            <button
              type="button"
              className="flex w-full items-center px-3 py-2 text-left text-xs text-[var(--foreground)] hover:bg-[var(--muted)]"
              onClick={() => {
                setRenameTarget(tabMenu.instance);
                setTabMenu(null);
              }}
            >
              {t('agent.mobilePanel.renameConversation')}
            </button>
            <button
              type="button"
              className="flex w-full items-center px-3 py-2 text-left text-xs text-[var(--destructive)] hover:bg-[var(--muted)]"
              onClick={() => {
                const target = tabMenu.instance;
                setTabMenu(null);
                requestDelete(target);
              }}
            >
              {t('agent.mobilePanel.deleteConversation')}
            </button>
          </div>
        </>
      )}

      <ConversationRenameDialog
        open={renameTarget !== null}
        initialTitle={renameTarget?.title ?? ''}
        onOpenChange={(next) => {
          if (!next) setRenameTarget(null);
        }}
        onSubmit={(title) => {
          if (!renameTarget) return;
          void useAgentSessionStore.getState().renameAgentConversation({
            instanceId: renameTarget.instanceId,
            threadId: renameTarget.threadId,
            title,
            typeKey: 'flowix',
          });
        }}
      />

      <Dialog open={deleteTarget !== null} onOpenChange={(next) => { if (!next) setDeleteTarget(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('agent.mobilePanel.deleteConversationTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 px-1 pb-1">
            <p className="text-xs text-[var(--muted-foreground)]">
              {t('agent.mobilePanel.deleteConversationHint')}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setDeleteTarget(null)}>
                {t('common.cancel')}
              </Button>
              <Button
                size="sm"
                className="bg-[var(--destructive)] text-white hover:bg-[var(--destructive)]/90"
                onClick={() => {
                  const target = deleteTarget;
                  setDeleteTarget(null);
                  if (target) void deleteConversation(target);
                }}
              >
                {t('agent.mobilePanel.deleteConversation')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Delete a never-persisted blank instance; ignore backend misses. */
async function builtinAiDeleteBlank(instanceId: string): Promise<void> {
  try {
    await invoke('agent_conversation_delete', { instanceId });
  } catch {
    // Blank instances are not persisted; a missing row is expected.
  }
}
