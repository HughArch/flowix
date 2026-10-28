import { convertFileSrc } from '@platform/tauri/core';
import { canonicalDirectoryPath, canonicalPath } from '@/lib/path';
import { assetMarkdownUrl, decodeStorageKey, isVideoUrl } from './markdown/asset-markdown';

export { assetMarkdownUrl, decodeStorageKey, isVideoUrl };

function isNativeEditorWebView(): boolean {
  if (typeof window === 'undefined') return false;
  const candidate = window as Window & {
    webkit?: { messageHandlers?: { flowixEditor?: { postMessage?: unknown } } };
  };
  return typeof candidate.webkit?.messageHandlers?.flowixEditor?.postMessage === 'function';
}

export function assetUrl(storageKey: string | null | undefined): string {
  if (!storageKey) return '';
  if (isNativeEditorWebView()) {
    const encoded = encodeURIComponent(storageKey)
      .replace(/\(/g, '%28')
      .replace(/\)/g, '%29');
    return `flowix-asset://localhost/${encoded}`;
  }
  return convertFileSrc(storageKey);
}

export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_');
}

const WINDOWS_ABSOLUTE_KEY = /^[a-zA-Z]:[\\/]/;
const UNC_ABSOLUTE_KEY = /^[\\/]{2}[^\\/]/;
const ATTACHMENTS_TAIL_KEY = /(?:^|[\\/])attachments[\\/]([^\\/]+)$/i;

/** Whether a storage key is a device-local absolute path rather than a notebook-relative key. */
export function isAbsoluteStorageKey(storageKey: string): boolean {
  const key = storageKey.trim();
  return WINDOWS_ABSOLUTE_KEY.test(key) || UNC_ABSOLUTE_KEY.test(key) || key.startsWith('/');
}

function comparablePath(path: string): string {
  const canonical = canonicalPath(path).replace(/\/+$/, '');
  // Drive-letter paths are case-insensitive; POSIX paths are not.
  return WINDOWS_ABSOLUTE_KEY.test(canonical) ? canonical.toLowerCase() : canonical;
}

/**
 * Resolve a persisted attachment key to an absolute path on this device.
 *
 * New content stores notebook-relative keys (`attachments/photo.jpg`) so the
 * same note works after FNS sync on another device. Older content persisted
 * absolute paths; when such a path does not belong to a local notebook it is
 * rebased onto the owning notebook's `attachments/` directory, because the sync
 * channel keeps the notebook-relative layout.
 */
export function resolveAttachmentStorageKey(
  storageKey: string,
  notebookPath?: string | null,
): string {
  const key = storageKey.trim();
  if (!key) return key;
  const root = notebookPath ? canonicalDirectoryPath(notebookPath) : null;
  if (!isAbsoluteStorageKey(key)) {
    if (!root) return key;
    const relative = canonicalPath(key).replace(/^\/+/, '');
    return root === '/' ? `/${relative}` : `${root}/${relative}`;
  }
  if (!root) return key;

  const comparableKey = comparablePath(key);
  const comparableRoot = comparablePath(root);
  if (comparableKey === comparableRoot || comparableKey.startsWith(`${comparableRoot}/`)) {
    return key;
  }

  const tail = ATTACHMENTS_TAIL_KEY.exec(canonicalPath(key));
  return tail ? `${root === '/' ? '' : root}/attachments/${tail[1]}` : key;
}

/** `asset:` URL for a persisted key, resolved against the owning notebook. */
export function resolveAttachmentUrl(storageKey: string, notebookPath?: string | null): string {
  return assetUrl(resolveAttachmentStorageKey(storageKey, notebookPath));
}
