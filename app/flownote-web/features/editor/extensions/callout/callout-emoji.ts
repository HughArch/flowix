import type { CalloutEmojiEntry, CalloutEmojiGroup } from './emoji-catalog';

/** Cap the rendered result set: a two-character query can match everything. */
export const CALLOUT_EMOJI_SEARCH_LIMIT = 300;

export interface CalloutEmojiSearchResult {
  entries: CalloutEmojiEntry[];
  /** True when the query matched more entries than the render limit. */
  truncated: boolean;
}

/**
 * Search the catalog by label or keyword, in either locale.
 *
 * All whitespace-separated terms must match (AND), so "笑 脸" narrows instead
 * of widening. Results keep the catalog's group/order, which puts the most
 * common emoji first within each category.
 */
export function searchCalloutEmojis(
  groups: readonly CalloutEmojiGroup[],
  query: string,
  limit = CALLOUT_EMOJI_SEARCH_LIMIT,
): CalloutEmojiSearchResult {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return { entries: [], truncated: false };

  const terms = normalized.split(/\s+/).filter(Boolean);
  const seen = new Set<string>();
  const entries: CalloutEmojiEntry[] = [];

  for (const group of groups) {
    for (const emoji of group.emojis) {
      const haystack = `${emoji.n} ${emoji.z} ${emoji.k}`.toLowerCase();
      if (!terms.every((term) => haystack.includes(term))) continue;
      if (seen.has(emoji.u)) continue;
      if (entries.length >= limit) return { entries, truncated: true };
      seen.add(emoji.u);
      entries.push(emoji);
    }
  }

  return { entries, truncated: false };
}

/** Lookup table for the "common" grid's titles when the catalog is loaded. */
export function indexCalloutEmojis(
  groups: readonly CalloutEmojiGroup[],
): Map<string, CalloutEmojiEntry> {
  const index = new Map<string, CalloutEmojiEntry>();
  for (const group of groups) {
    for (const emoji of group.emojis) index.set(emoji.u, emoji);
  }
  return index;
}
