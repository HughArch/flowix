import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureFileDisplayIdentity, rebaseFileDisplayPath, reconcileFileDisplays } from '@/lib/file-display-registry';
import { resolveDocumentTitlebarTarget, type DocumentTitlebarTarget } from './document-titlebar-model';
import { useDocumentTitlebarActions } from './use-document-titlebar-actions';

const mocks = vi.hoisted(() => ({ save: vi.fn(), archive: vi.fn(), error: vi.fn() }));
vi.mock('../store/document-session-service', () => ({
  saveDocumentPath: mocks.save, getDocumentBuffer: vi.fn(), applyLoadedDocumentContent: vi.fn(),
}));
vi.mock('@platform/tauri/client', () => ({ notes: { createVersion: mocks.archive }, product: {} }));
vi.mock('@features/preferences/public/font-api', () => ({ useEditorFontSize: () => ({ fontSize: 16, setFontSize: vi.fn() }) }));
vi.mock('./editor-font-switcher', () => ({ useEditorFontSwitch: () => ({}) }));
vi.mock('./use-document-titlebar-colors', () => ({ useDocumentTitlebarColors: () => ({ colors: [], changeColors: vi.fn() }) }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: mocks.error } }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ error: vi.fn(), warn: vi.fn() }) }));
let root: Root;
let model: ReturnType<typeof useDocumentTitlebarActions>;
let target: DocumentTitlebarTarget;
let resolveSave: (saved: boolean) => void;
let sequence = 0;
function Probe({ target }: { target: DocumentTitlebarTarget }) {
  model = useDocumentTitlebarActions(target);
  return null;
}
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.save.mockImplementation(() => new Promise<boolean>((resolve) => { resolveSave = resolve; }));
  mocks.archive.mockResolvedValue(undefined);
  const fileIdentity = ensureFileDisplayIdentity(`/book/archive-${++sequence}.md`);
  reconcileFileDisplays([fileIdentity]);
  target = resolveDocumentTitlebarTarget(fileIdentity, {
    fileIdentity, scopePath: '/book', notebookId: 'book', relativePath: `archive-${sequence}.md`, indexable: true,
  }, '/book');
  root = createRoot(document.createElement('div'));
  await act(async () => root.render(<Probe target={target} />));
});
afterEach(async () => { await act(async () => root.unmount()); });

describe('target-bound titlebar commands', () => {
  it('archives the original document if the titlebar switches targets while saving', async () => {
    let operation!: Promise<void>;
    act(() => { operation = model.archiveVersion(); });
    const fileIdentity = ensureFileDisplayIdentity(`/book/other-${sequence}.md`);
    reconcileFileDisplays([target.fileIdentity, fileIdentity]);
    const other = resolveDocumentTitlebarTarget(fileIdentity, null, '/book');
    await act(async () => root.render(<Probe key="other" target={other} />));
    await act(async () => { resolveSave(true); await operation; });
    expect(mocks.archive).toHaveBeenCalledExactlyOnceWith('book', target.relativePath);
  });

  it('does not archive a stale notebook-relative path if the file was renamed during the save', async () => {
    let operation!: Promise<void>;
    act(() => { operation = model.archiveVersion(); });
    rebaseFileDisplayPath(target.fileIdentity.path, `/book/renamed-${sequence}.md`, target.fileIdentity.displayId);
    await act(async () => { resolveSave(true); await operation; });
    expect(mocks.archive).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledOnce();
  });
});
