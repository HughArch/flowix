import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VersionHistoryDialog } from './document-version-history-menu';
import type { PathVersionMeta } from '@platform/tauri/client';

const mocks = vi.hoisted(() => ({
  listVersions: vi.fn(),
  // 必须是稳定引用: hook 的 effect deps 含 `t`, 每次 render 换新函数会让
  // effect 无限重跑 (loading 震荡), act 永不落定 → 测试整体超时。
  t: (key: string) => key,
}));
vi.mock('@platform/tauri/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@platform/tauri/client')>(),
  notes: { listVersions: (...args: unknown[]) => mocks.listVersions(...args) },
}));
vi.mock('@/lib/i18n', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/i18n')>(),
  useI18n: () => ({ t: mocks.t, language: 'zh-CN' }),
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

const versions: PathVersionMeta[] = [
  { id: 'v_1', createdAt: 2000, source: 'manual', size: 12, contentHash: 'h2' },
  { id: 'v_0', createdAt: 1000, source: 'auto', size: 10, contentHash: 'h1' },
];

function renderDialog(overrides?: Partial<Parameters<typeof VersionHistoryDialog>[0]>) {
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    notebookId: 'book',
    relativePath: 'a.md',
    refreshKey: 0,
    restoringVersionId: null,
    onSelectVersion: vi.fn(),
    ...overrides,
  };
  act(() => root.render(<VersionHistoryDialog {...props} />));
  return props;
}

describe('VersionHistoryDialog', () => {
  it('loads versions into rows, newest first', async () => {
    mocks.listVersions.mockResolvedValue(versions);
    renderDialog();
    await act(async () => { await Promise.resolve(); });
    const rows = [...document.querySelectorAll<HTMLButtonElement>('button[title="a.md"]')];
    expect(mocks.listVersions).toHaveBeenCalledWith('book', 'a.md');
    expect(rows).toHaveLength(2);
    // 新的在前: 行内容只含格式化时间/来源/路径/大小, 用 size 区分两条。
    expect(rows[0].textContent).toContain('12 B');
    expect(rows[1].textContent).toContain('10 B');
  });

  it('closes and forwards the picked version on select', async () => {
    mocks.listVersions.mockResolvedValue(versions);
    const props = renderDialog();
    await act(async () => { await Promise.resolve(); });
    const row = document.querySelector<HTMLButtonElement>('button[title="a.md"]')!;
    await act(async () => row.click());
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
    expect(props.onSelectVersion).toHaveBeenCalledWith(versions[0]);
  });

  it('renders the failed state instead of the empty state when loading rejects', async () => {
    mocks.listVersions.mockRejectedValue(new Error('boom'));
    renderDialog();
    await act(async () => { await Promise.resolve(); });
    expect(document.body.textContent).toContain('document.version.loadFailed');
    expect(document.body.textContent).not.toContain('document.version.empty');
  });

  it('renders nothing while closed', () => {
    renderDialog({ open: false });
    expect(document.querySelector('button[title="a.md"]')).toBeNull();
  });
});
