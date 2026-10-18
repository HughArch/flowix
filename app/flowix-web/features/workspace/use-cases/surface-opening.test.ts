import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openWork: vi.fn(), openBrowser: vi.fn(),
  prepareDocumentLeave: vi.fn(),
  workIdentity: null as { kind: 'external'; path: string } | null,
}));
vi.mock('./workspace-navigation', () => ({
  openExternalTarget: mocks.openWork,
  prepareActiveWorkColumnDocumentLeave: mocks.prepareDocumentLeave,
  openCollectionTarget: vi.fn(),
  openMediaLibraryTarget: vi.fn(), openMediaTarget: vi.fn(),
  openPluginWorkbench: vi.fn(), openTableTarget: vi.fn(), openWebTarget: vi.fn(),
}));
vi.mock('./browser-column-navigation', () => ({
  openBrowserColumnTarget: mocks.openBrowser,
  createFileBrowserTarget: (path: string, scopePath: string | null) => ({
    kind: 'file-browser', activeFilePath: path, scopePath, folderPath: null,
    notebookId: null, fileTreeVisible: true, fileTreeWidth: 220,
  }),
}));
vi.mock('./agent-conversation-navigation', () => ({ selectAndOpenAgentConversation: vi.fn() }));
vi.mock('../store/work-column-store', () => ({
  useWorkColumnStore: { getState: () => ({ navigation: { target: { kind: 'empty' } } }) },
}));
vi.mock('./workspace-content-activation', () => ({
  workColumnTargetIdentity: () => mocks.workIdentity,
  findWorkspaceContentLocations: () => ({ browserColumn: null }),
  findWorkspaceContentForNavigation: (identity: { kind: 'external'; path: string }) =>
    mocks.workIdentity?.path === identity.path ? { host: 'main-third', state: 'active' } : null,
  browserColumnTargetIdentity: (target: { activeFilePath: string }) => ({ kind: 'external', path: target.activeFilePath }),
}));
vi.mock('@platform/tauri/client', () => ({ collections: {}, notebooks: {} }));

import { openWorkspaceSurface } from './surface-opening';

describe('public surface opening host contract', () => {
  const target = { kind: 'external' as const, path: '/notes/a.md', scopePath: '/notes' };
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prepareDocumentLeave.mockResolvedValue(undefined);
    mocks.workIdentity = null;
    mocks.openWork.mockImplementation(async (path: string) => { mocks.workIdentity = { kind: 'external', path }; });
    mocks.openBrowser.mockResolvedValue({ host: 'browser-column', tabId: 'a', alreadyOpen: true });
  });

  it('defaults to Work without requiring a store transaction ID', async () => {
    await expect(openWorkspaceSurface({ target })).resolves.toEqual({
      status: 'opened', host: 'main-third', location: { host: 'main-third', state: 'active' },
    });
    expect(mocks.openWork).toHaveBeenCalledWith(target.path, expect.objectContaining({ destination: 'main-third' }));
    expect(mocks.openBrowser).not.toHaveBeenCalled();
  });

  it('keeps explicit Browser opens in Browser and forwards notebook context', async () => {
    await expect(openWorkspaceSurface({ host: 'browser-column', target, options: { notebookId: 'book' } }))
      .resolves.toEqual({ status: 'activated', host: 'browser-column', location: { host: 'browser-column', tabId: 'a' } });
    expect(mocks.openBrowser).toHaveBeenCalledWith(expect.objectContaining({ notebookId: 'book', activeFilePath: target.path }), undefined);
    expect(mocks.openWork).not.toHaveBeenCalled();
  });

  it('publishes Work changes before opening a second view of the same content', async () => {
    mocks.workIdentity = { kind: 'external', path: target.path };
    await openWorkspaceSurface({ host: 'browser-column', target });
    expect(mocks.prepareDocumentLeave).toHaveBeenCalledOnce();
    expect(mocks.prepareDocumentLeave.mock.invocationCallOrder[0]).toBeLessThan(mocks.openBrowser.mock.invocationCallOrder[0]);
  });

  it('preserves a cancelled Browser navigation result', async () => {
    mocks.openBrowser.mockResolvedValue(null);
    await expect(openWorkspaceSurface({ host: 'browser-column', target })).resolves.toEqual({
      status: 'cancelled', host: 'browser-column', reason: 'navigation-cancelled',
    });
    expect(mocks.openWork).not.toHaveBeenCalled();
  });

  it('reports a Work navigation superseded before its target becomes active as cancelled', async () => {
    mocks.openWork.mockImplementation(async () => undefined);
    await expect(openWorkspaceSurface({ target })).resolves.toEqual({
      status: 'cancelled', host: 'main-third', reason: 'navigation-cancelled',
    });
  });
});
