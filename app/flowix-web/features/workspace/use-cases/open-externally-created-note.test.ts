import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserColumnStore } from '../store/browser-column-store';
import { useWorkColumnStore } from '../store/work-column-store';
import { useWorkspaceFocusStore } from '../store/workspace-focus-store';
import { openExternallyCreatedNote } from './open-externally-created-note';
import { openWorkspaceSurface } from './surface-opening';

vi.mock('./surface-opening', () => ({ openWorkspaceSurface: vi.fn().mockResolvedValue(undefined) }));

const workTarget = { kind: 'external' as const, path: '/notes/Note.md', scopePath: '/notes', transitionId: null };

describe('external note creation notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkColumnStore.setState(useWorkColumnStore.getInitialState());
    useBrowserColumnStore.getState().reset();
    useWorkspaceFocusStore.getState().reset();
  });

  it('keeps Work focus and does not duplicate the document being edited', async () => {
    const work = useWorkColumnStore.getState();
    const requestId = work.beginNavigation(workTarget, null);
    work.commitNavigation(requestId, workTarget);
    await openExternallyCreatedNote('/notes/Note.md', '/notes', 'nb');
    expect(openWorkspaceSurface).not.toHaveBeenCalled();
    expect(useBrowserColumnStore.getState().tabs).toHaveLength(0);
    expect(useWorkspaceFocusStore.getState().focusedHostId).toBe('main-third');
  });

  it('does not steal focus for a document currently being opened in Work', async () => {
    useWorkColumnStore.getState().beginNavigation(workTarget, null);
    await openExternallyCreatedNote('/notes/Note.md', '/notes', 'nb');
    expect(openWorkspaceSurface).not.toHaveBeenCalled();
    expect(useWorkspaceFocusStore.getState().focusedHostId).toBe('main-third');
  });

  it('does not reactivate an inactive Browser tab or reveal the hidden column', async () => {
    const browser = useBrowserColumnStore.getState();
    for (const name of ['Note', 'Other']) {
      browser.openTab({ id: name, title: name, icon: null, target: {
        kind: 'file-browser', activeFilePath: `/notes/${name}.md`, notebookId: 'nb',
        folderPath: null, scopePath: '/notes', fileTreeVisible: false, fileTreeWidth: 220,
      } });
    }
    browser.setVisible(false);
    await openExternallyCreatedNote('/notes/Note.md', '/notes', 'nb');
    expect(openWorkspaceSurface).not.toHaveBeenCalled();
    expect(useBrowserColumnStore.getState()).toMatchObject({ activeTabId: 'Other', visible: false });
    expect(useWorkspaceFocusStore.getState().focusedHostId).toBe('main-third');
  });

  it('opens a genuinely new document through the usual browser navigation', async () => {
    await openExternallyCreatedNote('/notes/New.md', '/notes', 'nb');
    expect(openWorkspaceSurface).toHaveBeenCalledExactlyOnceWith({
      host: 'browser-column',
      target: { kind: 'external', path: '/notes/New.md', scopePath: '/notes', transitionId: null },
      options: { notebookId: 'nb' },
    });
  });
});
