import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentShareDialog } from './document-share-dialog';
import type { FnsShareView } from '@platform/tauri/client';

const mocks = vi.hoisted(() => ({
  shareQuery: vi.fn(),
  shareCreate: vi.fn(),
  shareCancel: vi.fn(),
  sharePassword: vi.fn(),
  onOpenChange: vi.fn(),
}));
// 真实 Provider 的 t 经 useMemo 稳定; mock 也必须返回同一函数实例,
// 否则依赖 t 的 useCallback 链会随每次渲染变 identity, 触发 effect 死循环。
const { stableT } = vi.hoisted(() => ({ stableT: (key: string) => key }));
vi.mock('@platform/tauri/client', () => ({
  fns: {
    shareQuery: mocks.shareQuery,
    shareCreate: mocks.shareCreate,
    shareCancel: mocks.shareCancel,
    sharePassword: mocks.sharePassword,
  },
  FNS_SHARE_EXPIRY_OPTIONS: [
    { value: 0, i18nKey: 'share.expiry.never' },
    { value: 86400, i18nKey: 'share.expiry.oneDay' },
    { value: 604800, i18nKey: 'share.expiry.sevenDays' },
    { value: 2592000, i18nKey: 'share.expiry.thirtyDays' },
  ],
}));
vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: stableT, language: 'zh-CN' }),
}));
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock('@features/shell/hooks/use-mobile-back-button', () => ({
  useMobileBackInterceptor: () => {},
}));
// Radix 风格的真实弹窗在 jsdom 里会因焦点陷阱挂住, 与其他弹窗测试一致用直通桩。
vi.mock('@shared/ui/dialog', () => {
  const Surface = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  return { Dialog: Surface, DialogContent: Surface, DialogHeader: Surface, DialogTitle: Surface, DialogDescription: Surface };
});

const ACTIVE_VIEW: FnsShareView = {
  id: 129,
  shareType: 'note',
  token: 'tok',
  isPassword: true,
  expiresAt: '0001-01-01T00:00:00Z',
  shortLink: '',
  baseUrl: 'https://fns.example.com',
  shareUrl: 'https://fns.example.com/share/129/tok',
};

function textOf(host: HTMLElement): string {
  return host.textContent ?? '';
}

async function clickButton(root: Root, container: HTMLElement, label: string) {
  const button = [...container.querySelectorAll('button')]
    .find((node) => textOf(node).includes(label) || node.getAttribute('aria-label') === label);
  expect(button, `button ${label} should exist`).toBeTruthy();
  await act(async () => {
    button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  void root;
}

/** React 受控 input 要经原生 value setter 写值, 否则 onChange 不触发。 */
function setNativeValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

let host: HTMLDivElement;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement('div');
  container = document.createElement('div');
  host.append(container);
  document.body.append(host);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

function renderDialog() {
  act(() => {
    root.render(
      <DocumentShareDialog
        open
        onOpenChange={mocks.onOpenChange}
        notebookId="book"
        relativePath="a.md"
      />,
    );
  });
}

describe('DocumentShareDialog', () => {
  it('shows the create form when no share exists', async () => {
    mocks.shareQuery.mockResolvedValue(null);
    renderDialog();
    await act(async () => {});
    expect(textOf(container)).toContain('share.createAction');
    expect(textOf(container)).not.toContain('share.cancelAction');
  });

  it('shows the link and management actions for an active share', async () => {
    mocks.shareQuery.mockResolvedValue(ACTIVE_VIEW);
    renderDialog();
    await act(async () => {});
    const input = container.querySelector('input[type="text"][readonly]') as HTMLInputElement | null;
    expect(input?.value).toBe(ACTIVE_VIEW.shareUrl);
    expect(textOf(container)).toContain('share.password.on');
    expect(textOf(container)).toContain('share.expiry.neverActive');
    expect(textOf(container)).toContain('share.cancelAction');
  });

  it('copies the share url from the copy button', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    mocks.shareQuery.mockResolvedValue(ACTIVE_VIEW);
    renderDialog();
    await act(async () => {});
    await clickButton(root, container, 'share.copyLink');
    expect(writeText).toHaveBeenCalledWith(ACTIVE_VIEW.shareUrl);
  });

  it('creates a share with password and expiry converted to unix seconds', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    mocks.shareQuery.mockResolvedValue(null);
    mocks.shareCreate.mockResolvedValue(ACTIVE_VIEW);
    renderDialog();
    await act(async () => {});
    const password = container.querySelector('input[type="password"]') as HTMLInputElement;
    await act(async () => {
      setNativeValue(password, '123');
    });
    await clickButton(root, container, 'share.createAction');
    expect(mocks.shareCreate).toHaveBeenCalledWith('book', 'a.md', '123', expect.any(Number));
    // 创建的链接直接进剪贴板, 不必再手动点复制。
    expect(writeText).toHaveBeenCalledWith(ACTIVE_VIEW.shareUrl);
    // 结果已交付 (剪贴板 + toast), 弹窗随即关闭, 不再原地刷新。
    expect(mocks.onOpenChange).toHaveBeenCalledWith(false);
    expect(mocks.shareQuery).toHaveBeenCalledTimes(1);
  });

  it('closes the dialog after updating the share settings', async () => {
    mocks.shareQuery.mockResolvedValue(ACTIVE_VIEW);
    mocks.sharePassword.mockResolvedValue(undefined);
    renderDialog();
    await act(async () => {});
    await clickButton(root, container, 'share.updateAction');
    expect(mocks.sharePassword).toHaveBeenCalledWith('book', 'a.md', undefined, 0);
    expect(mocks.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('requires confirmation before cancelling and then refreshes', async () => {
    mocks.shareQuery.mockResolvedValue(ACTIVE_VIEW);
    mocks.shareCancel.mockResolvedValue(undefined);
    renderDialog();
    await act(async () => {});
    await clickButton(root, container, 'share.cancelAction');
    expect(mocks.shareCancel).not.toHaveBeenCalled();
    await clickButton(root, container, 'share.cancelConfirm');
    expect(mocks.shareCancel).toHaveBeenCalledWith('book', 'a.md');
    expect(mocks.shareQuery).toHaveBeenCalledTimes(2);
  });
});
