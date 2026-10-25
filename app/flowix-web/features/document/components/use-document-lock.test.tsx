import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureFileDisplayIdentity, reconcileFileDisplays } from '@/lib/file-display-registry';
import { applyLoadedContent } from '../store/buffer-registry';
import { documentIdentityFromFile } from '../store/document-identity';
import { useDocumentLock } from './use-document-lock';

const mocks = vi.hoisted(() => ({
  set: vi.fn(),
  remove: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
}));
vi.mock('../public/path-properties', () => ({
  setDocumentProperties: mocks.set,
  removeDocumentProperty: mocks.remove,
}));
vi.mock('@/lib/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/i18n')>()),
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/toast', () => ({ toast: { error: mocks.error, success: mocks.success } }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ error: vi.fn(), warn: vi.fn() }) }));

let sequence = 0;
let root: Root;
let model: ReturnType<typeof useDocumentLock>;
let path: string;
let fileIdentity: ReturnType<typeof ensureFileDisplayIdentity>;

function Probe() {
  model = useDocumentLock(fileIdentity);
  return null;
}

function load(content: string) {
  applyLoadedContent(documentIdentityFromFile(fileIdentity), path, content, { setAsCurrent: false });
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.set.mockResolvedValue(true);
  mocks.remove.mockResolvedValue(true);
  path = `/book/lock-${++sequence}.md`;
  fileIdentity = ensureFileDisplayIdentity(path);
  reconcileFileDisplays([fileIdentity]);
  root = createRoot(document.createElement('div'));
  await act(async () => root.render(<Probe />));
});
afterEach(async () => { await act(async () => root.unmount()); });

describe('document lock', () => {
  it('derives the lock from the shared document buffer', async () => {
    expect(model.locked).toBe(false);
    await act(async () => load('---\nflowix_locked: true\n---\nbody'));
    expect(model.locked).toBe(true);
    await act(async () => load('---\nflowix_locked: true\n---\nchanged by sync'));
    expect(model.locked).toBe(true);
    await act(async () => load('body'));
    expect(model.locked).toBe(false);
  });

  it('persists the lock in the note frontmatter', async () => {
    await act(async () => { await model.toggle(); });
    expect(mocks.set).toHaveBeenCalledExactlyOnceWith(path, { flowix_locked: true });
    expect(mocks.success).toHaveBeenCalledOnce();
  });

  it('removes the frontmatter key when unlocking', async () => {
    await act(async () => load('---\nflowix_locked: true\n---\nbody'));
    await act(async () => { await model.toggle(); });
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith(path, 'flowix_locked');
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.success).toHaveBeenCalledOnce();
  });

  it('reports a failed write and stays unlocked', async () => {
    mocks.set.mockResolvedValue(false);
    await act(async () => { await model.toggle(); });
    expect(mocks.error).toHaveBeenCalledOnce();
    expect(mocks.success).not.toHaveBeenCalled();
    expect(model.locked).toBe(false);
  });

  it('ignores a second toggle while the first write is pending', async () => {
    let finish!: (saved: boolean) => void;
    mocks.set.mockImplementation(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    let operation!: Promise<void>;
    act(() => { operation = model.toggle(); });
    await act(async () => { await model.toggle(); });
    expect(mocks.set).toHaveBeenCalledOnce();
    await act(async () => { finish(true); await operation; });
  });
});
