import { subscribeNotebookChanges } from '@platform/tauri/notebook-change-events';
import {
  getAppNotebookPath,
  refreshAppPathNoteMetadata,
} from '@features/memo/public/app-api';
import { invalidateMentionNotes } from '@features/editor/extensions/note-mention/note-mention-data';
import { invalidateMentionTags } from '@features/editor/extensions/tag-mention/tag-mention-data';
import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';
import { rebaseStoredRecoveryDraftPaths } from '@features/document/public/workspace-api';
import { removeBrowserColumnTabsByPath, applyNotebookPathMove, openExternallyCreatedNote } from '@features/workspace/public/app-api';
import { clearWorkspaceTargetForDeletedFile } from '@features/workspace/public/shell-api';
import { createLogger } from '@/lib/logger';
import { joinNotebookMemoPath } from '@/lib/path';
import { invoke } from '@tauri-apps/api/core';
import { isMobileDevice } from '@shared/platform';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import type { AgentConversationInstance } from '@features/agent/store/agent-conversation-types';

const logger = createLogger('main-window-notebook-events');

/**
 * 移动端：删除文档时，连带删除绑定到它的内置助手会话
 * （thread + messages + instance）。匹配规则与右侧 AI 侧边栏的
 * 绑定规则一致：source.documentPath（绝对路径）或
 * notebookId + relativePath。只处理 flowix（thread-card source）会话。
 */
async function purgeDocumentConversations(
  notebookId: string,
  relativePath: string,
  absolutePath: string,
): Promise<void> {
  const instances = useAgentSessionStore.getState().conversationRegistry.instances;
  const matches: AgentConversationInstance[] = Object.values(instances).filter((instance) => {
    if (instance.agentType !== 'flowix' || instance.source.kind !== 'thread-card') return false;
    if (instance.source.documentPath === absolutePath) return true;
    return instance.source.notebookId === notebookId
      && !!instance.source.relativePath
      && (instance.source.relativePath === relativePath
        || `${relativePath}/`.startsWith(`${instance.source.relativePath}/`));
  });
  for (const instance of matches) {
    try {
      if (instance.threadId) {
        await invoke<boolean>('agent_builtin_delete_thread', { threadId: instance.threadId });
        useAgentSessionStore.getState().removeInstancesForThreadAndWait(instance.threadId);
      } else {
        useAgentSessionStore.getState().removeInstance(instance.instanceId);
      }
    } catch (error) {
      logger.warn('purge document conversation failed', { error, instanceId: instance.instanceId });
    }
  }
  if (matches.length > 0) {
    logger.info('purged document conversations after note deletion', {
      notebookId,
      relativePath,
      count: matches.length,
    });
  }
}

/** Mount the main window's production notebook path event projections. */
export function mountMainWindowNotebookEvents(): () => void {
  let pathChangeChain = Promise.resolve();
  let disposed = false;
  const unsubscribe = subscribeNotebookChanges((change) => {
    const { notebookId } = change;
    invalidateMentionNotes();
    invalidateMentionTags();
    refreshAppPathNoteMetadata(notebookId);

    if (change.kind === 'resource-created'
      && change.source === 'external_tool'
      && change.relativePath.split('/').pop() !== 'AGENTS.md'
      && useUserSettingsStore.getState().settings.autoOpenCreatedNotesInBrowser) {
      const { relativePath } = change;
      pathChangeChain = pathChangeChain.then(async () => {
        if (disposed) return;
        const notebookPath = await getAppNotebookPath(notebookId);
        const path = notebookPath && joinNotebookMemoPath(notebookPath, relativePath);
        if (disposed || !path || !notebookPath) return;
        await openExternallyCreatedNote(path, notebookPath, notebookId);
      }).catch((error) => logger.warn('open externally created note failed', { error, notebookId, relativePath }));
    }

    if (change.kind === 'path-moved') {
      const { previousRelativePath, relativePath, directory } = change;
      pathChangeChain = pathChangeChain.then(async () => {
        if (disposed) return;
        const notebookPath = await getAppNotebookPath(notebookId);
        if (!disposed && notebookPath) {
          applyNotebookPathMove({ notebookId, notebookPath, previousRelativePath, relativePath, directory });
          const previous = joinNotebookMemoPath(notebookPath, previousRelativePath);
          const next = joinNotebookMemoPath(notebookPath, relativePath);
          if (previous && next) await rebaseStoredRecoveryDraftPaths(previous, next, directory);
        }
      }).catch((error) => logger.warn('rebase moved note path failed', { error, notebookId, relativePath }));
    }

    if (change.kind === 'resource-deleted') {
      const { relativePath } = change;
      pathChangeChain = pathChangeChain.then(async () => {
        if (disposed) return;
        const notebookPath = await getAppNotebookPath(notebookId);
        if (disposed) return;
        const path = notebookPath && joinNotebookMemoPath(notebookPath, relativePath);
        if (path) {
          removeBrowserColumnTabsByPath(path);
          await clearWorkspaceTargetForDeletedFile(path);
          // 移动端专属：文档关联的内置助手会话随文档一起删除。
          // 桌面文档删除不清理会话（保持既有行为）。
          if (isMobileDevice() && notebookPath) {
            await purgeDocumentConversations(notebookId, relativePath, path);
          }
        }
      }).catch((error) => logger.warn('resolve deleted note path failed', { error, notebookId, relativePath }));
    }
  });
  return () => { disposed = true; unsubscribe(); };
}
