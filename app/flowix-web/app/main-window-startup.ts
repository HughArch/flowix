import {
  initializeNotebookContext,
  markMemoLibraryStartupError,
} from '@features/memo/public/app-api';
import { waitForInitialDocumentLoad } from '@features/document/public/startup-api';
import {
  captureWorkspaceRestoreTarget,
  restoreLegacyFolderListWorkspace,
  restoreAgentConversationWorkspace,
  restoreExternalDocumentWorkspace,
  restoreMediaWorkspace,
  restoreTableWorkspace,
  restoreCollectionWorkspace,
  restoreFolderCollectionWorkspace,
  setWorkspaceRestoreStatus,
  type PersistedWorkspaceTarget,
} from '@features/workspace/public/startup-api';
import { boot } from '@platform/tauri/client';
import { useWorkspaceStartupStore, waitForStartupTask } from '@/lib/store/workspace-startup-store';
import { getVisibleWorkspaceSurfaceHosts, getWorkColumnStartupIdentity } from '@features/workspace/public/shell-api';
import { getStartupListTask } from '@features/memo/public/startup-api';
import { beginWorkspaceSurfaceStartup, waitForWorkspaceSurfaceStartup } from '@features/surface/public/shell-api';

let startupAttemptSequence = 0;
let startupPromise: Promise<void> | null = null;

/**
 * Run the main-window startup stages in one failure-aware transaction.
 *
 * Notebook identity is resolved before workspace restoration. Stage 2 settles
 * after the current visible list and workspace surfaces report terminal states.
 */
export function initializeMainWindowStartup(): Promise<void> {
  if (startupPromise) return startupPromise;
  const { status } = useWorkspaceStartupStore.getState();
  if (status === 'ready' || status === 'degraded') return Promise.resolve();
  startupPromise = performMainWindowStartup().finally(() => { startupPromise = null; });
  return startupPromise;
}

async function performMainWindowStartup(): Promise<void> {
  const startedAt = performance.now();
  const nativeRuntime = isTauriRuntime();
  let nativeReady = !nativeRuntime;
  const startupAttemptId = `${Date.now()}-${++startupAttemptSequence}`;
  const logStage = (stage: string) => {
    const elapsedMs = Math.round(performance.now() - startedAt);
    console.info('[perf:startup]', stage, { elapsedMs });
    if (nativeRuntime) void boot.recordStartupStage(stage, elapsedMs, startupAttemptId).catch(() => undefined);
  };
  // Add required first-screen loads here in dependency order. Awaiting a task
  // automatically keeps stage 2 open; optional work belongs after startup.
  const runTask = async <T,>(task: string, operation: () => Promise<T>): Promise<T> => {
    useWorkspaceStartupStore.setState({ task });
    logStage(`task:${task}:start`);
    const result = await operation();
    logStage(`task:${task}:complete`);
    return result;
  };
  useWorkspaceStartupStore.setState({
    status: 'running', task: 'native-ready', error: null, startupTasks: {
      'memo-list': 'pending',
      'folder-list': 'pending',
      'conversation-list': 'pending',
    },
  });
  try {
    if (nativeRuntime) {
      await boot.waitForStartupReady();
      nativeReady = true;
      logStage('native-ready');
    }
    const startupNotebookId = nativeRuntime
      ? await runTask('notebook-selection', async () => {
          try {
            return await boot.getStartupNotebookId();
          } catch (error) {
            markMemoLibraryStartupError(error);
            throw error;
          }
        })
      : null;
    logStage('notebook-selected');
    await runTask('notebook-context', () => initializeNotebookContext(startupNotebookId));
    const desiredTarget = captureWorkspaceRestoreTarget();
    setWorkspaceRestoreStatus('restoring');
    try {
      await runTask('workspace-restore', () => restoreDesiredTarget(desiredTarget));
      logStage('workspace-restored');
      beginWorkspaceSurfaceStartup(getVisibleWorkspaceSurfaceHosts(), {
        'main-third': getWorkColumnStartupIdentity(),
      });
      const listTask = getStartupListTask();
      const [documentOutcome, memoOutcome, surfaceOutcome] = await runTask('first-screen-readiness', () => Promise.all([
        waitForInitialDocumentLoad(),
        waitForStartupTask(listTask),
        waitForWorkspaceSurfaceStartup(),
      ]));
      const degraded = documentOutcome === 'timeout' || memoOutcome !== 'ready' || surfaceOutcome !== 'ready';
      logStage(`first-screen-${degraded ? 'degraded' : 'ready'}`);
      // Empty content is ready. Errors, unavailable states and timeouts settle
      // as degraded so a local retry/error state remains reachable.
      setWorkspaceRestoreStatus(degraded ? 'unavailable' : 'restored');
      useWorkspaceStartupStore.setState({
        status: degraded ? 'degraded' : 'ready',
        task: degraded ? 'first-screen-readiness' : null,
        error: degraded ? 'Some visible workspace content did not become ready' : null,
      });
    } catch (error) {
      setWorkspaceRestoreStatus('unavailable');
      throw error;
    }
  } catch (error) {
    useWorkspaceStartupStore.setState({
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
    logStage(`task:${useWorkspaceStartupStore.getState().task}:failed`);
    throw error;
  } finally {
    if (nativeRuntime && nativeReady) {
      // Ready content, a degraded workspace, or the retry screen can now paint.
      // All three release background maintenance; native initialization failure
      // does not. This signal means foreground startup has settled.
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => resolve());
      }));
      const status = useWorkspaceStartupStore.getState().status;
      logStage(status === 'ready' ? 'first-workspace-paint' : `foreground-${status}-paint`);
      await boot.notifyStartupInteractive().catch(() => undefined);
    }
  }
}

async function restoreDesiredTarget(target: PersistedWorkspaceTarget | null): Promise<void> {
  if (!target) return;
  if (target.kind === 'external') {
    await restoreExternalDocumentWorkspace(target);
    return;
  }
  if (target.kind === 'media') {
    await restoreMediaWorkspace(target);
    return;
  }
  if (target.kind === 'collection') {
    await restoreCollectionWorkspace(target);
    return;
  }
  if (target.kind === 'folder-collection') {
    await restoreFolderCollectionWorkspace(target);
    return;
  }
  if (target.kind === 'table') {
    await restoreTableWorkspace(target);
    return;
  }
  if (target.kind === 'document-list') {
    await restoreLegacyFolderListWorkspace(target);
    return;
  }
  await restoreAgentConversationWorkspace();
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined'
    && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
}
