import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownDocumentSurface } from './markdown-document-surface';

const mocks = vi.hoisted(() => ({ read: vi.fn(), flush: vi.fn(), discard: vi.fn() }));
vi.mock('@platform/tauri/client', () => ({ notes: { readDocument: mocks.read } }));
vi.mock('@features/document/components/document-container', () => ({ DocumentContainer: ({ onFlushReady }: {
  onFlushReady: (flush: (() => Promise<boolean>) | null, discard: (() => void) | null) => void;
}) => {
  useEffect(() => { onFlushReady(mocks.flush, mocks.discard); return () => onFlushReady(null, null); }, [onFlushReady]);
  return <div>editor</div>;
} }));
vi.mock('@features/plugin/plugin-artifact-renderer', () => ({ PluginArtifactRenderer: ({ content }: { content: string }) => <div data-preview>{content}</div> }));

const content = (body: string) => `---
flowix_plugin:
  id: html
  renderer: html
---
${body}`;
let root: Root;
let host: HTMLDivElement;
const observer = vi.fn();
const reportPresentation = vi.fn();
const registerLifecycle = vi.fn();
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue(content('before'));
  mocks.flush.mockResolvedValue(true);
  host = document.createElement('div');
  root = createRoot(host);
  await act(async () => root.render(<MarkdownDocumentSurface fileIdentity={{ path: '/book/plugin.md', displayId: 'plugin' }}
    navigationViewId="browser-view" reportPresentation={reportPresentation} registerLifecycle={registerLifecycle}
    documentProps={{ isExternalDocument: true, documentSessionMode: 'isolated', onFlushReady: observer }} />));
});
afterEach(async () => { await act(async () => root.unmount()); });

describe('shared Markdown plugin preview session', () => {
  it('publishes the early document save port through the shared lifecycle bridge', () => {
    expect(registerLifecycle).toHaveBeenCalledWith({ status: 'ready', flush: mocks.flush, discard: mocks.discard }, expect.any(Object));
  });
  it('flushes the registered view and refreshes non-mindmap plugin previews', async () => {
    expect(observer).toHaveBeenCalledWith(mocks.flush, mocks.discard);
    expect(host.querySelector('[data-preview]')!.textContent).toBe('before');
    expect(reportPresentation).toHaveBeenCalledWith(expect.objectContaining({
      capabilities: expect.arrayContaining(['fullscreen']),
      appearance: expect.objectContaining({ headerStyle: 'document' }),
    }));
    await act(async () => host.querySelector('button')!.click());
    expect(reportPresentation).toHaveBeenLastCalledWith(expect.objectContaining({
      contentKind: 'file-markdown',
      capabilities: expect.arrayContaining(['edit']),
    }));
    mocks.read.mockResolvedValue(content('after'));
    await act(async () => host.querySelector('button')!.click());
    expect(mocks.flush).toHaveBeenCalledOnce();
    expect(mocks.read).toHaveBeenLastCalledWith('/book/plugin.md');
    expect(host.querySelector('[data-preview]')!.textContent).toBe('after');
    expect(reportPresentation).toHaveBeenLastCalledWith(expect.objectContaining({
      capabilities: ['fullscreen'],
      contentKind: 'plugin-artifact',
    }));
  });
  it('stays in the editor if that view cannot flush', async () => {
    await act(async () => host.querySelector('button')!.click());
    mocks.flush.mockResolvedValue(false);
    await act(async () => host.querySelector('button')!.click());
    expect(mocks.read).toHaveBeenCalledOnce();
    expect(host.querySelector('[data-preview]')).toBeNull();
  });
});
