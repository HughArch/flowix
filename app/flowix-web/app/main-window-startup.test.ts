import { beforeEach, describe, expect, it, vi } from 'vitest';
import { boot } from '@platform/tauri/client';
import { useWorkspaceStartupStore } from '@/lib/store/workspace-startup-store';
import { useNoteStore } from '@features/memo/store/note-store';
import { useDocumentStore } from '@features/document/store/document-store';
import { waitForInitialDocumentLoad } from '@features/document/public/startup-api';

const mocks = vi.hoisted(() => ({
  initializeNoteLibrary: vi.fn(),
  captureWorkspaceRestoreTarget: vi.fn(),
  restoreExternalDocumentWorkspace: vi.fn(),
  restoreMediaWorkspace: vi.fn(),
  restoreTableWorkspace: vi.fn(),
  restoreCollectionWorkspace: vi.fn(),
  setWorkspaceRestoreStatus: vi.fn(),
  restoreAgentConversationWorkspace: vi.fn(),
  calls: [] as string[],
}));

vi.mock('@features/memo/public/app-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@features/memo/public/app-api')>()),
  initializeNotebookContext: mocks.initializeNoteLibrary,
}));
vi.mock('@features/workspace/public/startup-api', () => ({
  captureWorkspaceRestoreTarget: mocks.captureWorkspaceRestoreTarget,
  restoreExternalDocumentWorkspace: mocks.restoreExternalDocumentWorkspace,
  restoreMediaWorkspace: mocks.restoreMediaWorkspace,
  restoreTableWorkspace: mocks.restoreTableWorkspace,
  restoreCollectionWorkspace: mocks.restoreCollectionWorkspace,
  setWorkspaceRestoreStatus: mocks.setWorkspaceRestoreStatus,
  restoreAgentConversationWorkspace: mocks.restoreAgentConversationWorkspace,
}));
vi.mock('@features/workspace/public/shell-api', () => ({
  getVisibleWorkspaceSurfaceHosts: () => [],
  getWorkColumnStartupIdentity: () => '',
}));
vi.mock('@features/memo/public/startup-api', () => ({
  getStartupListTask: () => 'memo-list',
}));
vi.mock('@features/surface/public/shell-api', () => ({
  beginWorkspaceSurfaceStartup: vi.fn(),
  waitForWorkspaceSurfaceStartup: vi.fn().mockResolvedValue('ready'),
}));
vi.mock('@/lib/store/workspace-startup-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/store/workspace-startup-store')>()),
  waitForStartupTask: vi.fn().mockResolvedValue('ready'),
}));

import { initializeMainWindowStartup } from './main-window-startup';

describe('initializeMainWindowStartup', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useWorkspaceStartupStore.setState({ status: 'idle', task: null, error: null });
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    useNoteStore.getState().setStartupPhase('idle');
    useDocumentStore.setState({ isDocumentTransitioning: false, documentTransitionId: 0 });
    mocks.calls.length = 0;
    mocks.initializeNoteLibrary.mockReset().mockImplementation(async () => {
      mocks.calls.push('memo-library');
    });
    mocks.captureWorkspaceRestoreTarget.mockReset().mockReturnValue(null);
    mocks.restoreExternalDocumentWorkspace.mockReset();
    mocks.restoreMediaWorkspace.mockReset();
    mocks.setWorkspaceRestoreStatus.mockReset();
    mocks.restoreAgentConversationWorkspace.mockReset().mockImplementation(async () => {
      mocks.calls.push('agent-workspace');
    });
  });

  it('runs startup stages in dependency order', async () => {
    await initializeMainWindowStartup();

    expect(useWorkspaceStartupStore.getState().status).toBe('ready');
    expect(mocks.calls).toEqual([
      'memo-library',
    ]);
  });

  it('stops dependent restoration when library initialization fails', async () => {
    mocks.initializeNoteLibrary.mockRejectedValueOnce(new Error('backend unavailable'));

    await expect(initializeMainWindowStartup()).rejects.toThrow('backend unavailable');
    expect(useWorkspaceStartupStore.getState()).toMatchObject({
      status: 'failed', task: 'notebook-context', error: 'backend unavailable',
    });
    expect(mocks.restoreExternalDocumentWorkspace).not.toHaveBeenCalled();
    expect(mocks.restoreAgentConversationWorkspace).not.toHaveBeenCalled();
  });

  it('shows a retryable error when the native notebook identity cannot be read', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(boot, 'waitForStartupReady').mockResolvedValue();
    vi.spyOn(boot, 'getStartupNotebookId').mockRejectedValue(new Error('notebook identity unavailable'));
    const notifyInteractive = vi.spyOn(boot, 'notifyStartupInteractive').mockResolvedValue();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });

    await expect(initializeMainWindowStartup()).rejects.toThrow('notebook identity unavailable');

    expect(mocks.initializeNoteLibrary).not.toHaveBeenCalled();
    expect(useNoteStore.getState().startupPhase).toBe('error');
    expect(notifyInteractive).toHaveBeenCalledOnce();
  });

  it('holds background maintenance until the restored document finishes loading', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(boot, 'waitForStartupReady').mockResolvedValue();
    vi.spyOn(boot, 'getStartupNotebookId').mockResolvedValue('notebook-a');
    vi.spyOn(boot, 'recordStartupStage').mockResolvedValue();
    const notifyInteractive = vi.spyOn(boot, 'notifyStartupInteractive').mockResolvedValue();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    mocks.captureWorkspaceRestoreTarget.mockReturnValue({ kind: 'external', path: '/notes/active.md', scopePath: '/notes' });
    mocks.restoreExternalDocumentWorkspace.mockImplementationOnce(async () => {
      useDocumentStore.setState({ isDocumentTransitioning: true, documentTransitionId: 1 });
    });

    const startup = initializeMainWindowStartup();
    await vi.waitFor(() => expect(useDocumentStore.getState().isDocumentTransitioning).toBe(true));
    expect(notifyInteractive).not.toHaveBeenCalled();
    expect(useWorkspaceStartupStore.getState()).toMatchObject({ status: 'running', task: 'first-screen-readiness' });

    useDocumentStore.getState().finishDocumentTransition(1);
    await startup;
    expect(notifyInteractive).toHaveBeenCalledOnce();
  });

  it('does not release background maintenance after native initialization fails', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(boot, 'waitForStartupReady').mockRejectedValueOnce(new Error('migration failed'));
    const notify = vi.spyOn(boot, 'notifyStartupInteractive').mockResolvedValue();
    await expect(initializeMainWindowStartup()).rejects.toThrow('migration failed');
    expect(notify).not.toHaveBeenCalled();
    expect(mocks.initializeNoteLibrary).not.toHaveBeenCalled();
    expect(useWorkspaceStartupStore.getState()).toMatchObject({ status: 'failed', task: 'native-ready' });
  });

  it('shares the startup barrier across concurrent mounts', async () => {
    let finish!: () => void;
    mocks.initializeNoteLibrary.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const first = initializeMainWindowStartup();
    const second = initializeMainWindowStartup();
    expect(second).toBe(first);
    expect(mocks.initializeNoteLibrary).toHaveBeenCalledOnce();
    expect(useWorkspaceStartupStore.getState().status).toBe('running');
    finish();
    await first;
    expect(useWorkspaceStartupStore.getState().status).toBe('ready');
  });

  it('retains a failed restoration task and exposes a retryable startup error', async () => {
    mocks.captureWorkspaceRestoreTarget.mockReturnValue({ kind: 'external', path: '/missing.md', scopePath: null });
    mocks.restoreExternalDocumentWorkspace.mockRejectedValueOnce(new Error('restore unavailable'));
    await expect(initializeMainWindowStartup()).rejects.toThrow('restore unavailable');
    expect(useWorkspaceStartupStore.getState()).toMatchObject({
      status: 'failed', task: 'workspace-restore', error: 'restore unavailable',
    });
    expect(mocks.setWorkspaceRestoreStatus).toHaveBeenLastCalledWith('unavailable');
  });

  it('settles stage 2 as degraded when the initial document times out', async () => {
    vi.useFakeTimers();
    try {
      mocks.captureWorkspaceRestoreTarget.mockReturnValue({ kind: 'external', path: '/slow.md', scopePath: null });
      mocks.restoreExternalDocumentWorkspace.mockImplementationOnce(async () => {
        useDocumentStore.setState({ isDocumentTransitioning: true, documentTransitionId: 1 });
      });
      const startup = initializeMainWindowStartup();
      await vi.advanceTimersByTimeAsync(60_000);
      await startup;
      expect(useWorkspaceStartupStore.getState()).toMatchObject({ status: 'degraded', task: 'first-screen-readiness' });
      expect(mocks.setWorkspaceRestoreStatus).toHaveBeenLastCalledWith('unavailable');
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the initial document barrier if its load stalls', async () => {
    vi.useFakeTimers();
    try {
      useDocumentStore.setState({ isDocumentTransitioning: true, documentTransitionId: 1 });
      const wait = waitForInitialDocumentLoad(100);
      await vi.advanceTimersByTimeAsync(100);
      await expect(wait).resolves.toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });
});
