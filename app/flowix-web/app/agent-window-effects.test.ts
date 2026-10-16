import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  waitForStartupReady: vi.fn(async (): Promise<void> => undefined),
  useAgentEvents: vi.fn(),
  refreshRuntime: vi.fn(async () => undefined),
  loadAccess: vi.fn(async () => undefined),
  initializePiMode: vi.fn(async () => undefined),
  listenAccess: vi.fn(),
  unlistenAccess: vi.fn(),
  invalidateNotebookCache: vi.fn(),
  prewarmNotebookCache: vi.fn(async () => undefined),
  invalidateMentionNotes: vi.fn(),
  invalidateMentionTags: vi.fn(),
  acquireMemoEventBridge: vi.fn(),
  releaseMemoEventBridge: vi.fn(),
}));

vi.mock('@features/agent/services/agent-catalog-service', () => ({ prefetchAvailableAgentModels: vi.fn(), prefetchNotebookSkills: vi.fn() }));
vi.mock('@features/memo/store/note-store', () => ({ useNoteStore: (selector: (state: { selectedNotebook: null }) => unknown) => selector({ selectedNotebook: null }) }));
vi.mock('@features/agent/hooks/use-agent-events', () => ({
  useAgentEvents: mocks.useAgentEvents,
}));
vi.mock('@features/agent/store/agent-runtime-store', () => ({
  useAgentRuntimeStore: (selector: (state: { refresh: typeof mocks.refreshRuntime }) => unknown) => (
    selector({ refresh: mocks.refreshRuntime })
  ),
}));
vi.mock('@features/agent/store/agent-data-store', () => ({
  useAgentDataStore: (selector: (state: { workspaceActions: { loadInitial: typeof mocks.loadAccess }; initializePiMode: typeof mocks.initializePiMode }) => unknown) => (
    selector({ workspaceActions: { loadInitial: mocks.loadAccess }, initializePiMode: mocks.initializePiMode })
  ),
}));
vi.mock('@features/editor/extensions/note-link', () => ({
  invalidateNotebookCache: mocks.invalidateNotebookCache,
  prewarmNotebookCache: mocks.prewarmNotebookCache,
}));
vi.mock('@features/editor/extensions/note-mention', () => ({
  invalidateMentionNotes: mocks.invalidateMentionNotes,
}));
vi.mock('@features/editor/extensions/tag-mention', () => ({
  invalidateMentionTags: mocks.invalidateMentionTags,
}));
vi.mock('@platform/tauri/client', () => ({
  boot: { waitForStartupReady: mocks.waitForStartupReady },
  listenToAgentWorkspaceChanges: mocks.listenAccess,
}));
vi.mock('@/lib/memo-dispatcher', () => ({
  acquireMemoEventBridge: () => {
    mocks.acquireMemoEventBridge();
    return mocks.releaseMemoEventBridge;
  },
}));

import { AgentWindowEffects } from './agent-window-effects';
import { useAgentWorkspaceWindowSync } from './use-agent-workspace-window-sync';

function PreferencesAccessSync() {
  useAgentWorkspaceWindowSync();
  return null;
}

describe('AgentWindowEffects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listenAccess.mockReturnValue(mocks.unlistenAccess);
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it('loads and synchronizes access preferences without mounting the Agent runtime', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => root.render(createElement(PreferencesAccessSync)));

    expect(mocks.loadAccess).toHaveBeenCalledOnce();
    expect(mocks.initializePiMode).toHaveBeenCalledOnce();
    expect(mocks.listenAccess).toHaveBeenCalledOnce();
    expect(mocks.refreshRuntime).not.toHaveBeenCalled();
    expect(mocks.useAgentEvents).not.toHaveBeenCalled();
    expect(mocks.prewarmNotebookCache).not.toHaveBeenCalled();

    await act(async () => mocks.listenAccess.mock.calls[0][0]());
    expect(mocks.loadAccess).toHaveBeenCalledTimes(2);

    const { onListenerReady } = mocks.listenAccess.mock.calls[0][1];
    await act(async () => onListenerReady());
    expect(mocks.loadAccess).toHaveBeenCalledTimes(3);
    // Reconcile again if the native listener reconnects after a failure.
    await act(async () => onListenerReady());
    expect(mocks.loadAccess).toHaveBeenCalledTimes(4);

    await act(async () => root.unmount());
    expect(mocks.unlistenAccess).toHaveBeenCalledOnce();
  });

  it('waits for native startup before reading workspace data', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    let ready!: () => void;
    mocks.waitForStartupReady.mockImplementationOnce(() => new Promise<void>((resolve) => { ready = resolve; }));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(PreferencesAccessSync)));
      expect(mocks.loadAccess).not.toHaveBeenCalled();
      expect(mocks.initializePiMode).not.toHaveBeenCalled();
      expect(mocks.listenAccess).not.toHaveBeenCalled();
      await act(async () => ready());
      expect(mocks.loadAccess).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    }
  });

  it('does not read workspace data when native initialization fails', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    mocks.waitForStartupReady.mockRejectedValueOnce(new Error('migration failed'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const root = createRoot(document.createElement('div'));
    try {
      await act(async () => root.render(createElement(PreferencesAccessSync)));
      expect(mocks.loadAccess).not.toHaveBeenCalled();
      expect(mocks.initializePiMode).not.toHaveBeenCalled();
      expect(mocks.listenAccess).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      warn.mockRestore();
      Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    }
  });

  it('owns the shared Agent lifecycle for a content-capable Webview', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(AgentWindowEffects));
    });

    expect(mocks.useAgentEvents).toHaveBeenCalledOnce();
    expect(mocks.acquireMemoEventBridge).toHaveBeenCalledOnce();
    expect(mocks.refreshRuntime).toHaveBeenCalledWith({ force: true });
    expect(mocks.loadAccess).not.toHaveBeenCalled();
    expect(mocks.listenAccess).toHaveBeenCalledOnce();
    expect(mocks.prewarmNotebookCache).toHaveBeenCalledOnce();

    await act(async () => root.unmount());
    expect(mocks.unlistenAccess).toHaveBeenCalledOnce();
    expect(mocks.releaseMemoEventBridge).toHaveBeenCalledOnce();
  });
});
