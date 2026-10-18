'use client';

import { useEffect } from "react";
import { subscribeNotebookChanges } from '@platform/tauri/notebook-change-events';
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useI18n } from "@/lib/i18n";
import { subscribeAppActiveAgentConversation } from "@features/document/public/app-api";
import {
  mountNotebookBackgroundUpdates,
  mountMemoListRefreshService,
  applyAppMemoCreated,
  applyAppMemoDeleted,
  applyAppMemoUpdated,
  applyAppTagsDeleted,
  applyAppTagsRenamed,
  getAppSelectedNotebookId,
  getAppNotebookPath,
  refreshAppDerivedMetadata,
  refreshAppPathNoteMetadata,
  refreshAppTodoCount,
} from "@features/memo/public/app-api";
import { invalidateMentionNotes } from "@features/editor/extensions/note-mention";
import {
  invalidateMentionTags,
  setNotebookIdProvider,
} from "@features/editor/extensions/tag-mention";
import { toast } from "@/lib/toast";
import { handleMainWindowMemoEvent } from "./main-window-memo-event-handler";
import type { MemoEvent } from "@/types/memo";
import {
  mountOpenTargetListener,
  unmountOpenTargetListener,
} from "@features/memo/public/app-api";
import { initializeMainWindowStartup } from './main-window-startup';
import { createLogger } from '@/lib/logger';
import { joinNotebookMemoPath } from '@/lib/path';
import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';
import { resumePendingNoteLinkUpdates } from '@features/memo/public/app-api';
import { subscribeWorkspaceDocumentSaves, rebaseStoredRecoveryDraftPaths } from '@features/document/public/workspace-api';
import {
  syncAppAgentConversationRestore,
  removeBrowserColumnTabsByPath,
  applyNotebookPathMove,
} from '@features/workspace/public/app-api';
import { openWorkspaceSurface } from '@features/workspace/public/open-surface-api';
import { clearWorkspaceTargetForDeletedFile } from '@features/workspace/public/shell-api';
import {
  dismissNavigationFailure,
  retryLastNavigation,
  useWorkspaceNavigationFailure,
} from '@features/workspace/public/main-window-api';
import {
  clearActionableNotice,
  upsertActionableNotice,
} from '@features/notifications/actionable-notice-store';

const logger = createLogger('main-window-effects');
const NAVIGATION_FAILURE_NOTICE_ID = 'workspace-navigation-failure';

export function MainWindowEffects() {
  const { t } = useI18n();
  const mainWindowTitle = t("window.main.title");
  const navigationFailure = useWorkspaceNavigationFailure();

  useEffect(() => {
    if (!navigationFailure) {
      clearActionableNotice(NAVIGATION_FAILURE_NOTICE_ID);
      return;
    }
    upsertActionableNotice({
      id: NAVIGATION_FAILURE_NOTICE_ID,
      priority: 100,
      tone: 'error',
      title: t('shell.navigation.failed'),
      message: navigationFailure.message,
      actions: [{ id: 'retry', label: t('error.retry'), run: retryLastNavigation }],
      dismissible: true,
      onDismiss: dismissNavigationFailure,
      revision: navigationFailure.requestId,
    });
  }, [navigationFailure, t]);

  useEffect(() => () => clearActionableNotice(NAVIGATION_FAILURE_NOTICE_ID), []);

  useEffect(() => mountNotebookBackgroundUpdates(), []);
  useEffect(() => mountMemoListRefreshService(), []);

  useEffect(() => {
    return subscribeWorkspaceDocumentSaves(resumePendingNoteLinkUpdates);
  }, []);

  useEffect(() => {
    setNotebookIdProvider(
      getAppSelectedNotebookId,
    );
    return () => {
      setNotebookIdProvider(() => null);
    };
  }, []);

  useEffect(() => {
    return subscribeAppActiveAgentConversation(syncAppAgentConversationRestore);
  }, []);

  useEffect(() => {
    // The main window resolves notebook identity before document restoration.
    // Cards, folders, and conversations then own their view data independently.
    void initializeMainWindowStartup()
      .catch((error) => {
        logger.warn('restore workspace failed', { error });
      });
  }, []);

  useEffect(() => {
    document.title = mainWindowTitle;
    void getCurrentWindow().setTitle(mainWindowTitle).catch(() => {
      // Browser preview or unavailable Tauri window API.
    });
  }, [mainWindowTitle]);

  useEffect(() => {
    let pathChangeChain = Promise.resolve();
    let disposed = false;
    const unsubscribe = subscribeNotebookChanges(
      (change) => {
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
            await openWorkspaceSurface({
              host: 'browser-column',
              target: { kind: 'external', path, scopePath: notebookPath, transitionId: null },
              options: { notebookId },
            });
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
            }
          }).catch((error) => logger.warn('resolve deleted note path failed', { error, notebookId, relativePath }));
        }
      },
    );
    return () => { disposed = true; unsubscribe(); };
  }, []);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let unsubscribeDerived: (() => void) | undefined;
    let disposed = false;

    void import("@/lib/memo-dispatcher").then(({ registerMemoEventHandler, registerMemoDerivedRefreshHandler }) => {
      if (disposed) return;
      unsubscribeDerived = registerMemoDerivedRefreshHandler((event) => {
        invalidateMentionNotes();
        invalidateMentionTags();
        if (getAppSelectedNotebookId() === event.notebookId) {
          refreshAppDerivedMetadata(event);
        } else if (event.derivedChanged.todos) {
          refreshAppTodoCount(event.notebookId);
        }
      });
      unsubscribe = registerMemoEventHandler((event) => {
        handleMainWindowMemoEvent(event, {
          getSelectedNotebookId: getAppSelectedNotebookId,
          invalidateMentionCaches: () => {
            invalidateMentionNotes();
            invalidateMentionTags();
          },
          openPathInBrowserColumn: async (notebookId, relativePath) => {
            const notebookPath = await getAppNotebookPath(notebookId);
            const path = notebookPath && joinNotebookMemoPath(notebookPath, relativePath);
            if (!path) throw new Error('Created note path is unavailable');
            await openWorkspaceSurface({
              host: 'browser-column',
              target: { kind: 'external', path, scopePath: notebookPath, transitionId: null },
              options: { notebookId },
            });
          },
          reportOpenFailure: (error) => {
            logger.warn('open created note in browser column failed', { error });
            toast.error(error instanceof Error ? error.message : String(error));
          },
          handleMemoCreated: applyAppMemoCreated,
          handleMemoUpdated: applyAppMemoUpdated,
          handleMemoDeleted: applyAppMemoDeleted,
          removeBrowserColumnTabsByPath: (path) => removeBrowserColumnTabsByPath(path),
          clearWorkspaceTargetByPath: (path) => {
            void clearWorkspaceTargetForDeletedFile(path).catch((error) =>
              logger.warn('clear deleted document target failed', { error, path }));
          },
          handleTagsRenamed: applyAppTagsRenamed,
          handleTagsDeleted: applyAppTagsDeleted,
          refreshSelectedNotebookMetadata,
          refreshBackgroundTodoCount: refreshAppTodoCount,
        });
      });
    });

    return () => {
      disposed = true;
      unsubscribe?.();
      unsubscribeDerived?.();
    };
  }, []);

  useEffect(() => {
    void mountOpenTargetListener();
    return () => {
      unmountOpenTargetListener();
    };
  }, []);

  return null;
}

function refreshSelectedNotebookMetadata(event: MemoEvent): void {
  // tags_renamed / tags_deleted 不走这条路径 (handler 早返回了), 但函
  // 数类型是 MemoEvent 联合, 需要在这里收窄 ── 这两个 kind 没有
  // derivedChanged 字段。
  if (event.kind === 'tags_renamed' || event.kind === 'tags_deleted') return;
  refreshAppDerivedMetadata(event);
}
