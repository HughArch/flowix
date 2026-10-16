import { useCallback, useEffect, useRef, useState } from 'react';
import { agentClient } from '@features/agent/store/agent-client';
import { normalizeBackendInstance } from '@features/agent/store/conversation-slice';
import type { AgentTypeKey } from '@/types/agent';
import type { AgentConversationCursor } from '@platform/tauri/client/agent';
import { createLogger } from '@/lib/logger';
import {
  EMPTY_CONVERSATION_PAGE_STATE,
  mergeConversationPage,
  updateConversationTitle,
  type ConversationPageState,
} from './conversation-list-pagination';

const logger = createLogger('conversation-list-data');
const CONVERSATION_PAGE_SIZE = 30;

function firstPageQueryKey(
  notebookId: string | null,
  agentType: AgentTypeKey | null,
  lifecycleVersion: number,
  retry: number,
): string {
  return `${notebookId ?? ''}\u001f${agentType ?? ''}\u001f${lifecycleVersion}\u001f${retry}`;
}

interface ConversationListDataOptions {
  notebookId: string | null;
  agentType: AgentTypeKey | null;
  lifecycleVersion: number;
}

/** Owns the backend list snapshot, cursor, loading states, and query invalidation. */
export function useConversationListData({
  notebookId,
  agentType,
  lifecycleVersion,
}: ConversationListDataOptions) {
  const [conversationPage, setConversationPage] = useState<ConversationPageState>(
    EMPTY_CONVERSATION_PAGE_STATE,
  );
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [settledQueryKey, setSettledQueryKey] = useState<string | null>(null);
  const [firstPageRetry, setFirstPageRetry] = useState(0);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [agentTypeCounts, setAgentTypeCounts] = useState<Readonly<Record<string, number>>>({});
  const nextCursorRef = useRef<AgentConversationCursor | null>(null);
  const listQueryKeyRef = useRef('');
  const loadingMoreRef = useRef(false);
  const requestSequenceRef = useRef(0);

  // The list owns a durable paged snapshot from the backend. Zustand is only
  // merged for live rows created or mounted in this window; history is never
  // hydrated wholesale just to render the sidebar.
  useEffect(() => {
    let active = true;
    const queryKey = firstPageQueryKey(notebookId, agentType, lifecycleVersion, firstPageRetry);
    if (!notebookId) {
      requestSequenceRef.current += 1;
      loadingMoreRef.current = false;
      listQueryKeyRef.current = queryKey;
      nextCursorRef.current = null;
      setConversationPage(EMPTY_CONVERSATION_PAGE_STATE);
      setHasMore(false);
      setLoadError(false);
      setLoadMoreError(false);
      setIsLoadingMore(false);
      setAgentTypeCounts({});
      setIsLoading(false);
      setSettledQueryKey(queryKey);
      return () => {
        active = false;
      };
    }
    const query = { notebookId, agentType, cursor: null } as const;
    const queryChanged = listQueryKeyRef.current !== queryKey;
    // Invalidate any in-flight page request before starting a new first page.
    // A stale request must not append rows or clear the new query's loading UI.
    requestSequenceRef.current += 1;
    loadingMoreRef.current = false;
    setIsLoadingMore(false);
    listQueryKeyRef.current = queryKey;
    nextCursorRef.current = null;
    if (queryChanged) {
      setConversationPage(EMPTY_CONVERSATION_PAGE_STATE);
      setHasMore(true);
      setLoadMoreError(false);
    }
    setLoadError(false);
    setSettledQueryKey(null);
    // Lifecycle changes can trigger a fresh first page after the view is
    // mounted, keeping deletion/archive state aligned with the backend.
    setIsLoading(true);
    void agentClient.listConversationInstancesPage(query, CONVERSATION_PAGE_SIZE)
      .then(({ items, hasMore: nextHasMore, nextCursor }) => {
        if (!active) return;
        nextCursorRef.current = nextCursor;
        setHasMore(nextHasMore);
        setConversationPage(mergeConversationPage(
          EMPTY_CONVERSATION_PAGE_STATE,
          items.map(normalizeBackendInstance),
        ));
      })
      .catch((error) => {
        logger.error('failed to load conversations', { error });
        if (active) setLoadError(true);
      })
      .finally(() => {
        if (active) {
          setIsLoading(false);
          setSettledQueryKey(queryKey);
        }
      });
    return () => {
      active = false;
    };
  }, [notebookId, agentType, lifecycleVersion, firstPageRetry]);

  // Facets stay small even when the conversation history is large. This lets
  // the agent filter describe the complete notebook while the conversation
  // rows themselves remain cursor-paginated.
  useEffect(() => {
    let active = true;
    if (!notebookId) {
      setAgentTypeCounts({});
      return () => {
        active = false;
      };
    }
    void agentClient.listConversationTypeCountsByNotebook(notebookId)
      .then((counts) => {
        if (!active) return;
        setAgentTypeCounts(Object.fromEntries(
          counts.map(({ agentType, count }) => [agentType, count]),
        ));
      })
      .catch((error) => {
        logger.error('failed to load conversation type counts', { error });
      });
    return () => {
      active = false;
    };
  }, [notebookId, lifecycleVersion]);

  const loadMoreConversations = useCallback(async (retry = false) => {
    if (!notebookId || loadingMoreRef.current || !hasMore || isLoading || loadError || (loadMoreError && !retry)) return;
    loadingMoreRef.current = true;
    setIsLoadingMore(true);
    setLoadMoreError(false);
    const queryKey = firstPageQueryKey(notebookId, agentType, lifecycleVersion, firstPageRetry);
    const requestSequence = ++requestSequenceRef.current;
    try {
      const query = { notebookId, agentType, cursor: nextCursorRef.current };
      const { items, hasMore: nextHasMore, nextCursor } = await agentClient.listConversationInstancesPage(
        query,
        CONVERSATION_PAGE_SIZE,
      );
      if (
        listQueryKeyRef.current !== queryKey
        || requestSequenceRef.current !== requestSequence
      ) return;
      nextCursorRef.current = nextCursor;
      setHasMore(nextHasMore);
      setConversationPage((current) => mergeConversationPage(
        current,
        items.map(normalizeBackendInstance),
      ));
    } catch (error) {
      logger.error('failed to load more conversations', { error });
      if (
        listQueryKeyRef.current === queryKey
        && requestSequenceRef.current === requestSequence
      ) setLoadMoreError(true);
    } finally {
      if (requestSequenceRef.current === requestSequence) {
        loadingMoreRef.current = false;
        setIsLoadingMore(false);
      }
    }
  }, [
    notebookId,
    agentType,
    lifecycleVersion,
    firstPageRetry,
    hasMore,
    isLoading,
    loadError,
    loadMoreError,
  ]);

  const retryFirstPage = useCallback(() => {
    setFirstPageRetry((value) => value + 1);
  }, []);

  const updateTitle = useCallback((instanceId: string, title: string, updatedAt: number) => {
    setConversationPage((current) => updateConversationTitle(current, instanceId, title, updatedAt));
  }, []);

  return {
    conversationPage,
    isLoading,
    loadError,
    isLoadingMore,
    loadMoreError,
    hasMore,
    agentTypeCounts,
    settledQueryKey,
    queryKey: firstPageQueryKey(notebookId, agentType, lifecycleVersion, firstPageRetry),
    loadMore: loadMoreConversations,
    retryFirstPage,
    updateTitle,
  };
}
