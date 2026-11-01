import { decodeStorageKey, resolveAttachmentUrl } from '@features/editor/extensions/attachment-link/utils';
import { BUILTIN_COVER_URL_BY_KEY } from './builtin-covers';

/**
 * Resolve a persisted `flowix_cover` value to a display URL.
 *
 * Supported value forms:
 * - `builtin:covers/<file>.jpg` — asset bundled with the app, rendered directly;
 * - `https://…` / `http://…` — remote cover URL, rendered as-is;
 * - anything else — attachment key (`asset://localhost/…` decoded first, then
 *   plain notebook-relative keys resolved against the notebook root).
 */
export function resolveNoteCoverUrl(
  cover: string | null | undefined,
  notebookPath?: string | null,
): string | null {
  if (!cover) return null;
  if (cover.startsWith('builtin:')) {
    return BUILTIN_COVER_URL_BY_KEY.get(cover) ?? null;
  }
  if (/^https?:\/\//i.test(cover)) return cover;
  const storageKey = decodeStorageKey(cover) ?? cover;
  return resolveAttachmentUrl(storageKey, notebookPath);
}
