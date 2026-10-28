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

const ABSOLUTE_KEY = /^[a-zA-Z]:[\\/]|^\//;

/** Whether a storage key is already a device-local absolute path. */
export function isAbsoluteStorageKey(storageKey: string): boolean {
  return ABSOLUTE_KEY.test(storageKey.trim());
}

/**
 * Resolve a persisted attachment key to an absolute path on this device.
 *
 * Content stores notebook-relative keys (`attachments/photo.jpg`) so the same
 * note works after FNS sync on another device; each device joins the key onto
 * its own notebook root.
 */
export function resolveAttachmentStorageKey(
  storageKey: string,
  notebookPath?: string | null,
): string {
  const key = storageKey.trim();
  if (!key || isAbsoluteStorageKey(key)) return key;
  const root = notebookPath ? canonicalDirectoryPath(notebookPath) : null;
  if (!root) return key;
  const relative = canonicalPath(key).replace(/^\/+/, '');
  return root === '/' ? `/${relative}` : `${root}/${relative}`;
}

/** `asset:` URL for a persisted key, resolved against the owning notebook. */
export function resolveAttachmentUrl(storageKey: string, notebookPath?: string | null): string {
  return assetUrl(resolveAttachmentStorageKey(storageKey, notebookPath));
}
