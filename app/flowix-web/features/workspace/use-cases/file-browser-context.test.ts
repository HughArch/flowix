import { beforeEach, expect, it, vi } from 'vitest';
import { captureFileBrowserContext, resolveFileBrowserContext } from './file-browser-context';

const data = vi.hoisted(() => ({
  selected: 'other',
  notebooks: [{ id: 'notes', path: '/notes' }, { id: 'nested', path: '/notes/project' }, { id: 'other', path: '/other' }],
}));
vi.mock('@features/memo/public/workspace-api', () => ({
  getSelectedWorkspaceNotebookId: () => data.selected,
  getWorkspaceMemoState: () => ({ notebooks: data.notebooks }),
}));
vi.mock('@features/agent/public/workspace-api', () => ({
  getWorkspaceAgentResourceFolders: () => ['/repo'],
}));
beforeEach(() => { data.selected = 'other'; });

it('binds the deepest owning notebook even when another notebook is selected', () => {
  expect(captureFileBrowserContext('/notes/project/a.md')).toMatchObject({
    notebookId: 'nested', scopePath: '/notes/project',
  });
});

it('preserves an explicit scope and browsing preferences', () => {
  const context = { notebookId: 'other', scopePath: '/notes/project/sub', folderPath: '/notes/project/sub', fileTreeVisible: false, fileTreeWidth: 320 };
  expect(resolveFileBrowserContext('/notes/project/sub/a.md', context)).toEqual({ ...context, notebookId: 'nested' });
});

it('repairs a restored context without depending on the selected notebook', () => {
  const context = { notebookId: 'other', scopePath: null, folderPath: null, fileTreeVisible: false, fileTreeWidth: 300 };
  expect(resolveFileBrowserContext('/notes/a.md', context)).toEqual({ ...context, notebookId: 'notes', scopePath: '/notes' });
});

it('uses resource roots outside notebooks and rejects neighboring directories', () => {
  expect(captureFileBrowserContext('/repo/a.md').scopePath).toBe('/repo');
  expect(captureFileBrowserContext('/notes-other/a.md').scopePath).toBeNull();
  expect(captureFileBrowserContext('/notes/../outside/a.md').scopePath).toBeNull();
});

it('preserves native ownership when the real path also matches an outer notebook', () => {
  data.notebooks.push({ id: 'alias', path: '/alias-notebook' });
  try {
    const context = {
      notebookContextPath: '/notes/sub/a.pdf', notebookId: 'alias', scopePath: '/alias-notebook',
      folderPath: null, fileTreeVisible: true, fileTreeWidth: 220,
    };
    const resolved = resolveFileBrowserContext('/notes/sub/a.pdf', context);
    expect(resolved).toEqual(context);
    // Browser preparation resolves the context again before opening its tab.
    expect(resolveFileBrowserContext('/notes/sub/a.pdf', resolved)).toEqual(context);
  } finally {
    data.notebooks.pop();
  }
});

it('invalidates native ownership when switching files or when its notebook is removed', () => {
  const context = {
    notebookContextPath: '/notes/a.pdf', notebookId: 'notes', scopePath: '/notes',
    folderPath: null, fileTreeVisible: true, fileTreeWidth: 220,
  };
  expect(resolveFileBrowserContext('/other/b.pdf', context)).toMatchObject({
    notebookContextPath: undefined, notebookId: 'other', scopePath: '/other',
  });
  expect(resolveFileBrowserContext('/notes/a.pdf', { ...context, notebookId: 'deleted' })).toMatchObject({
    notebookContextPath: undefined, notebookId: 'notes', scopePath: '/notes',
  });
});
