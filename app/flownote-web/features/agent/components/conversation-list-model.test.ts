import { describe, expect, it } from 'vitest';
import type { AgentConversationInstance } from '@features/agent/store/agent-conversation-types';
import { EMPTY_CONVERSATION_PAGE_STATE, mergeConversationPage } from './conversation-list-pagination';
import { buildConversationListItems, selectVisibleConversations } from './conversation-list-model';

function conversation(id: string, updatedAt: number, notebookId = 'nb'): AgentConversationInstance {
  return { instanceId: id, threadId: id, agentType: 'codex', title: id, source: { kind: 'dedicated', notebookId }, createdAt: updatedAt, updatedAt };
}
const idle = { isLoadingMore: false, loadMoreError: false };

describe('conversation list model', () => {
  it('retains backend-only history, merges live duplicates and filters notebook, tombstones and synthetic sessions', () => {
    const history = conversation('history', 100);
    const duplicate = conversation('duplicate', 200);
    const synthetic = { ...conversation('legacy-ses_old', 500), agentType: 'opencode' as const, threadId: 'ses_old' };
    const page = mergeConversationPage(EMPTY_CONVERSATION_PAGE_STATE, [history, duplicate, conversation('other', 600, 'other'), conversation('deleted', 700), synthetic]);
    const rows = selectVisibleConversations(page, {
      duplicate: { ...duplicate, updatedAt: 300, title: 'new title' },
      live: conversation('live', 400), otherLive: conversation('otherLive', 800, 'other'),
    }, 'nb', { deleted: true });
    expect(rows.map((row) => row.instanceId)).toEqual(['live', 'duplicate', 'history']);
    expect(rows[1].title).toBe('new title');
  });

  it('allows all notebooks when none is selected', () => {
    const page = mergeConversationPage(EMPTY_CONVERSATION_PAGE_STATE, [conversation('other', 200, 'other')]);
    expect(selectVisibleConversations(page, { live: conversation('live', 100) }, null, {}).map((row) => row.instanceId)).toEqual(['other', 'live']);
  });

  it('puts favorites first by creation time and partitions date boundaries without duplicating rows', () => {
    const today = new Date(2026, 9, 22).getTime();
    const day = 86400000;
    const items = buildConversationListItems([
      { ...conversation('favorite-old', today + 10), createdAt: 1 },
      conversation('today', today), conversation('yesterday', today - day),
      conversation('week', today - 7 * day), conversation('earlier', today - 7 * day - 1),
      { ...conversation('favorite-new', today - 9 * day), createdAt: 2 },
    ], new Set(['favorite-old', 'favorite-new']), idle, new Date(today + 100));
    expect(items.filter((row) => row.kind === 'heading').map((row) => row.sectionKey)).toEqual(['favorites', 'today', 'yesterday', 'last7Days', 'earlier']);
    expect(items.filter((row) => row.kind === 'conversation').map((row) => row.instance.instanceId)).toEqual(['favorite-new', 'favorite-old', 'today', 'yesterday', 'week', 'earlier']);
    expect(items.slice(0, 4).map((row) => row.size)).toEqual([24, 38, 36, 40]);
  });

  it('omits empty groups and preserves pagination footer geometry', () => {
    expect(buildConversationListItems([], new Set(), idle)).toEqual([]);
    expect(buildConversationListItems([], new Set(), { isLoadingMore: true, loadMoreError: true })).toEqual([{ kind: 'loading', key: 'loading-more', size: 36 }]);
    expect(buildConversationListItems([], new Set(), { isLoadingMore: false, loadMoreError: true })).toEqual([{ kind: 'more-error', key: 'loading-more-error', size: 52 }]);
  });
});
