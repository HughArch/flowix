import { convertFileSrc } from '@platform/tauri/core';
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
