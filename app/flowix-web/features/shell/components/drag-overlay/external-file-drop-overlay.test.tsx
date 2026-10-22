import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { FLOWIX_EXTERNAL_DOCUMENT_OPEN_EVENT } from '@platform/open-target/types';

const state = vi.hoisted(() => ({ options: null as null | { onDropPaths: (paths: string[], destination?: 'main-third' | 'browser-column') => void } }));
vi.mock('@features/document/public/shell-api', () => ({
  useExternalFileDrop: (options: typeof state.options) => {
    state.options = options;
    return { isDraggingFile: false, draggingDestination: null };
  },
}));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));

import { ExternalFileDropOverlay } from './external-file-drop-overlay';

it('preserves the entire dropped batch and the Browser destination in the dialog request', async () => {
  const root = createRoot(document.createElement('div'));
  const receive = vi.fn();
  window.addEventListener(FLOWIX_EXTERNAL_DOCUMENT_OPEN_EVENT, receive);
  try {
    await act(async () => root.render(<ExternalFileDropOverlay />));
    state.options!.onDropPaths(['/a.md', '/b.pdf'], 'browser-column');
    expect(receive).toHaveBeenCalledTimes(1);
    expect(receive.mock.calls[0][0].detail).toEqual({
      filePaths: ['/a.md', '/b.pdf'], source: 'drop', destination: 'browser-column',
    });
  } finally {
    window.removeEventListener(FLOWIX_EXTERNAL_DOCUMENT_OPEN_EVENT, receive);
    await act(async () => root.unmount());
  }
});
