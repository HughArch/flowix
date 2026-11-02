const FAVORITES_STORAGE_KEY = 'flownote:favorite-conversations';
const FAVORITES_CHANGE_EVENT = 'flownote:favorite-conversations-change';

export function readFavoriteConversationIds(): ReadonlySet<string> {
  if (typeof window === 'undefined') return new Set();

  try {
    const stored = JSON.parse(window.localStorage.getItem(FAVORITES_STORAGE_KEY) ?? '[]');
    return new Set(
      Array.isArray(stored)
        ? stored.filter((id): id is string => typeof id === 'string')
        : [],
    );
  } catch {
    return new Set();
  }
}

export function isFavoriteConversation(instanceId: string): boolean {
  return readFavoriteConversationIds().has(instanceId);
}

export function toggleFavoriteConversation(instanceId: string): ReadonlySet<string> {
  const next = new Set(readFavoriteConversationIds());
  if (next.has(instanceId)) next.delete(instanceId);
  else next.add(instanceId);

  try {
    window.localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify([...next]));
    window.dispatchEvent(new CustomEvent(FAVORITES_CHANGE_EVENT));
  } catch {
    // localStorage is optional in embedded/private browser contexts.
  }

  return next;
}

export function subscribeToFavoriteConversationChanges(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener(FAVORITES_CHANGE_EVENT, listener);
  return () => window.removeEventListener(FAVORITES_CHANGE_EVENT, listener);
}
