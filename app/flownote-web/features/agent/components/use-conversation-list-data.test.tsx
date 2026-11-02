import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentConversationInstance,
  AgentConversationListPage,
} from '@platform/tauri/client/agent';

const mocks = vi.hoisted(() => ({
  listPage: vi.fn(),
  typeCounts: vi.fn(),
}));

vi.mock('@features/agent/store/agent-client', () => ({
  agentClient: {
    listConversationInstancesPage: mocks.listPage,
    listConversationTypeCountsByNotebook: mocks.typeCounts,
  },
}));
vi.mock('@features/agent/store/conversation-slice', () => ({
  normalizeBackendInstance: (instance: AgentConversationInstance) => ({
    ...instance,
    title: instance.threadTitle ?? '',
  }),
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn() }),
}));

import { useConversationListData } from './use-conversation-list-data';

function conversation(instanceId: string, notebookId = 'nb-1'): AgentConversationInstance {
  return {
    instanceId,
    agentType: 'codex',
    threadId: instanceId,
    threadTitle: instanceId,
    source: { kind: 'dedicated', notebookId },
    createdAt: 1,
    updatedAt: 1,
  };
}

function page(ids: string[], hasMore = false, notebookId = 'nb-1'): AgentConversationListPage {
  return {
    items: ids.map((id) => conversation(id, notebookId)),
    hasMore,
    nextCursor: hasMore ? { updatedAt: 1, instanceId: ids[ids.length - 1] } : null,
  };
}

function deferredPage() {
  let resolve!: (page: AgentConversationListPage) => void;
  const promise = new Promise<AgentConversationListPage>((done) => { resolve = done; });
  return { promise, resolve };
}

let root: Root;
let latest: ReturnType<typeof useConversationListData> | null;

function Harness({ notebookId, isActive = true, lifecycleVersion = 0 }: { notebookId: string; isActive?: boolean; lifecycleVersion?: number }) {
  latest = useConversationListData({ notebookId, isActive, agentType: null, lifecycleVersion });
  return null;
}

function data() {
  if (!latest) throw new Error('Harness is not mounted');
  return latest;
}

async function render(notebookId = 'nb-1', isActive = true, lifecycleVersion = 0) {
  await act(async () => root.render(createElement(Harness, { notebookId, isActive, lifecycleVersion })));
}

describe('conversation list data', () => {
  beforeEach(() => {
    mocks.listPage.mockReset();
    mocks.typeCounts.mockReset().mockResolvedValue([{ agentType: 'codex', count: 3 }]);
    latest = null;
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
  });

  it('uses the cursor and blocks duplicate pagination requests while merging rows', async () => {
    const nextPage = deferredPage();
    mocks.listPage.mockResolvedValueOnce(page(['a'], true))
      .mockReturnValueOnce(nextPage.promise);
    await render();

    let pending: Promise<void> | undefined;
    await act(async () => {
      pending = data().loadMore();
      void data().loadMore();
    });
    expect(mocks.listPage).toHaveBeenCalledTimes(2);
    expect(mocks.listPage).toHaveBeenLastCalledWith({
      notebookId: 'nb-1', agentType: null, cursor: { updatedAt: 1, instanceId: 'a' },
    }, 30);
    expect(data().isLoadingMore).toBe(true);

    await act(async () => {
      nextPage.resolve(page(['a', 'b']));
      await pending;
    });
    expect(Object.keys(data().conversationPage.itemsByIdentity).sort()).toEqual(['thread:a', 'thread:b']);
    expect(data().hasMore).toBe(false);
    expect(data().isLoadingMore).toBe(false);
    expect(mocks.typeCounts).not.toHaveBeenCalled();
  });

  it('ignores an old page after switching notebooks without clearing the new loading state', async () => {
    const oldPage = deferredPage();
    const newFirstPage = deferredPage();
    mocks.listPage.mockResolvedValueOnce(page(['a'], true))
      .mockReturnValueOnce(oldPage.promise)
      .mockReturnValueOnce(newFirstPage.promise)
      .mockResolvedValueOnce(page(['c'], false, 'nb-2'));
    await render();
    let pending: Promise<void> | undefined;
    await act(async () => { pending = data().loadMore(); });
    await render('nb-2');

    await act(async () => {
      oldPage.resolve(page(['old']));
      await pending;
    });
    expect(data().conversationPage.orderedIdentities).toEqual([]);
    expect(data().isLoading).toBe(true);
    expect(data().isLoadingMore).toBe(false);

    await act(async () => newFirstPage.resolve(page(['b'], true, 'nb-2')));
    await act(async () => { await data().loadMore(); });
    expect(mocks.listPage).toHaveBeenLastCalledWith({
      notebookId: 'nb-2', agentType: null, cursor: { updatedAt: 1, instanceId: 'b' },
    }, 30);
    expect(Object.keys(data().conversationPage.itemsByIdentity).sort()).toEqual(['thread:b', 'thread:c']);
  });

  it('retries failed first and next pages while preserving the pagination cursor', async () => {
    mocks.listPage.mockRejectedValueOnce(new Error('first page unavailable'))
      .mockResolvedValueOnce(page(['a'], true))
      .mockRejectedValueOnce(new Error('next page unavailable'))
      .mockResolvedValueOnce(page(['b']));
    await render();
    expect(data().loadError).toBe(true);
    expect(data().isLoading).toBe(false);
    await act(async () => data().retryFirstPage());
    expect(data().loadError).toBe(false);

    await act(async () => { await data().loadMore(); });
    expect(data().loadMoreError).toBe(true);
    await act(async () => { await data().loadMore(); });
    expect(mocks.listPage).toHaveBeenCalledTimes(3);
    await act(async () => { await data().loadMore(true); });
    expect(mocks.listPage).toHaveBeenLastCalledWith({
      notebookId: 'nb-1', agentType: null, cursor: { updatedAt: 1, instanceId: 'a' },
    }, 30);
    expect(data().loadMoreError).toBe(false);
    expect(data().isLoadingMore).toBe(false);
    expect(data().conversationPage.orderedIdentities).toHaveLength(2);
  });
  it('preserves loaded pages across closing and reopening without another request', async () => {
    mocks.listPage.mockResolvedValueOnce(page(['a'], true)).mockResolvedValueOnce(page(['b']));
    await render();
    await act(async () => { await data().loadMore(); });
    const snapshot = data().conversationPage;
    await render('nb-1', false);
    await act(async () => { await data().loadMore(); });
    await render();
    expect(mocks.listPage).toHaveBeenCalledTimes(2);
    expect(data().conversationPage).toBe(snapshot);
  });

  it('defers hidden invalidations until reopening and ignores an interrupted next page', async () => {
    const stalePage = deferredPage();
    mocks.listPage.mockResolvedValueOnce(page(['a'], true))
      .mockReturnValueOnce(stalePage.promise).mockResolvedValueOnce(page(['fresh']));
    await render();
    let pending: Promise<void> | undefined;
    await act(async () => { pending = data().loadMore(); });
    await render('nb-1', false, 1);
    await act(async () => { stalePage.resolve(page(['stale'])); await pending; });
    expect(mocks.listPage).toHaveBeenCalledTimes(2);
    expect(data().conversationPage.orderedIdentities).toEqual(['thread:a']);
    await render('nb-1', true, 1);
    expect(mocks.listPage).toHaveBeenCalledTimes(3);
    expect(data().conversationPage.orderedIdentities).toEqual(['thread:fresh']);
  });

  it('reloads the original notebook if another notebook replaced its cached pages', async () => {
    const interrupted = deferredPage();
    mocks.listPage.mockResolvedValueOnce(page(['a']))
      .mockReturnValueOnce(interrupted.promise).mockResolvedValueOnce(page(['a-fresh']));
    await render();
    await render('nb-2');
    await render('nb-1', false);
    await act(async () => interrupted.resolve(page(['b'], false, 'nb-2')));
    await render();
    expect(mocks.listPage).toHaveBeenCalledTimes(3);
    expect(data().conversationPage.orderedIdentities).toEqual(['thread:a-fresh']);
  });

});
