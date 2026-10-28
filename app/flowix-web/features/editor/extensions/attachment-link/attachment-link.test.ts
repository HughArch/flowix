import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it, vi } from 'vitest';

// jsdom has no Tauri internals; mirror the asset URL shape the app uses.
vi.mock('@platform/tauri/core', () => ({
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
  invoke: vi.fn(),
}));

import { AttachmentLink } from './index';

function createEditor(attachment: Record<string, unknown>, notebookPath?: string) {
  const host = document.createElement('div');
  document.body.append(host);
  return new Editor({
    element: host,
    extensions: [
      StarterKit,
      AttachmentLink.configure(notebookPath ? { getNotebookPath: () => notebookPath } : {}),
    ],
    content: {
      type: 'doc',
      content: [{ type: 'image', attrs: attachment }],
    },
  });
}

describe('AttachmentLink storage key resolution', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('resolves a notebook-relative key against the notebook root', () => {
    const editor = createEditor(
      {
        src: 'asset://localhost/attachments%2Fphoto.jpg',
        alt: 'photo',
        storageMode: 'attachment',
        storageKey: 'attachments/photo.jpg',
      },
      'C:\\vault',
    );

    const img = editor.view.dom.querySelector('img');
    // Joined keys use the canonical forward-slash form.
    expect(img?.dataset.src).toBe('asset://localhost/C%3A%2Fvault%2Fattachments%2Fphoto.jpg');
  });
});
