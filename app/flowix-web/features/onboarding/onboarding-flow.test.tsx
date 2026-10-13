import { act, useCallback, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BootFeatures, NotebookImportStatus, NotebookRecord } from '@platform/tauri/client';

// Only desktop IPC and unrelated window chrome are replaced. The wizard, registration,
// boot controller, empty-notebook policy, import monitoring and retry UI run together.
const mocks = vi.hoisted(() => ({
  getFeatures: vi.fn(),
  setOnboardingCompleted: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
  getDefaultPath: vi.fn(),
  getImportStatus: vi.fn(),
  getTemplateSetupStatus: vi.fn(),
  ensureTemplateSetup: vi.fn(),
  confirmPresetOverwrite: vi.fn(),
  startImport: vi.fn(),
  selectNotebook: vi.fn(),
  listeners: new Set<(status: NotebookImportStatus) => void>(),
}));

vi.mock('@platform/tauri/client', () => ({
  boot: {
    getFeatures: mocks.getFeatures,
    setOnboardingCompleted: mocks.setOnboardingCompleted,
    setIntroDisplayed: vi.fn(),
  },
  consumeAppUpdateResult: async () => null,
  dshIntegration: { downloadStatus: async () => null },
  notebooks: {
    getDefaultPath: mocks.getDefaultPath,
    listTemplates: async () => [{
      id: 'project', name: '项目管理', description: '示例项目模板',
      sourceDirectory: 'project', icon: 'briefcase', category: '工作',
    }],
  },
  dialogs: { selectDirectory: async () => null },
  listenToNotebookImportStatus: (handler: (status: NotebookImportStatus) => void) => {
    mocks.listeners.add(handler);
    return () => mocks.listeners.delete(handler);
  },
}));
vi.mock('@platform/tauri/event-bus', () => ({ subscribe: () => () => {} }));
vi.mock('@features/memo/services/note-repository', () => ({ notebookRepository: {
  create: mocks.create, list: mocks.list, getDefaultPath: mocks.getDefaultPath,
  getImportStatus: mocks.getImportStatus, getTemplateSetupStatus: mocks.getTemplateSetupStatus,
  ensureTemplateSetup: mocks.ensureTemplateSetup, confirmPresetOverwrite: mocks.confirmPresetOverwrite,
  startImport: mocks.startImport,
} }));
vi.mock('@features/memo/services', async () => ({
  ...(await import('@features/memo/services/notebook-creation-service')),
  ...(await import('@features/memo/services/note-repository')),
}));
vi.mock('@features/memo/public/shell-api', async () => ({
  ...(await import('@features/memo/services/notebook-creation-service')),
}));
vi.mock('@features/memo/store/note-store', async () => {
  const { create } = await import('zustand');
  return { useNoteStore: create(() => ({
    selectedNotebook: null as NotebookRecord | null,
    setNotebooks: () => {},
  })) };
});
vi.mock('@features/workspace/public/shell-api', () => ({ selectNotebook: mocks.selectNotebook }));
vi.mock('@features/preferences/public/app-api', () => ({
  useAppUpdatePreferences: () => ({ loading: false, enabled: false }),
}));
vi.mock('@features/preferences/public/system-api', () => ({
  useDshRuntimeInstaller: () => ({ busy: false, status: null }),
}));
vi.mock('@features/shell/public/system-api', () => ({ useAppUpdater: () => ({}) }));
vi.mock('@shared/window-titlebar-controls', () => ({ WindowsTitlebarControls: () => null }));
vi.mock('@features/shortcuts', () => ({ isMac: () => false }));
vi.mock('@features/memo/components/notebook-icon-popover', () => ({ NotebookIconPopover: () => null }));

import { I18nProvider } from '@/lib/i18n';
import { useMainWindowSystemController } from '@app/main-window/use-main-window-system-controller';
import { useNoteStore } from '@features/memo/store/note-store';
import { useEmptyNotebookPrompt } from '@features/memo/hooks/use-empty-notebook-prompt';
import { finishOnboardingNotebook } from '@features/shell/use-cases/finish-onboarding';
import { ActionableNoticeHost } from '@features/notifications/actionable-notice-host';
import { clearActionableNotice, getActionableNotices } from '@features/notifications/actionable-notice-store';
import { OnboardingScreen } from './onboarding-screen';

const notebook: NotebookRecord = {
  id: 'first-book', name: 'My Notebook', path: '/notes/My Notebook',
  createdAt: 1, updatedAt: 1, isDefault: false,
};
let savedBoot: BootFeatures;
let host: HTMLDivElement;
let root: Root;

function FirstRunHarness() {
  const system = useMainWindowSystemController();
  const selectedNotebook = useNoteStore((state) => state.selectedNotebook);
  const [ordinaryCreateOpen, setOrdinaryCreateOpen] = useState(false);
  const [introOpen, setIntroOpen] = useState(false);
  const openCreate = useCallback(() => setOrdinaryCreateOpen(true), []);
  useEmptyNotebookPrompt({
    startupReady: true,
    hasSelectedNotebook: Boolean(selectedNotebook),
    suppressed: system.onboardingLoading || system.onboardingOpen,
    openCreate,
  });
  return <>
    {ordinaryCreateOpen && <div data-ordinary-create>普通新建笔记本</div>}
    {system.dshInstallPromptOpen && <div data-agent-intro>Agent 安装引导</div>}
    {selectedNotebook && <div data-workspace>{selectedNotebook.name}</div>}
    {introOpen && <div data-product-intro>产品介绍</div>}
    {system.onboardingOpen && <OnboardingScreen onFinish={async (book, options) => {
      await finishOnboardingNotebook(book, options, {
        completeOnboarding: system.completeOnboarding,
        failureTitle: '笔记本初始化失败', retryLabel: '重试',
      });
      setIntroOpen(true);
    }} />}
    <ActionableNoticeHost />
  </>;
}

async function mount() {
  await act(async () => root.render(<I18nProvider language="zh-CN"><FirstRunHarness /></I18nProvider>));
}

function button(text: string): HTMLButtonElement {
  const element = [...host.querySelectorAll('button')].find((node) => node.textContent?.trim() === text);
  expect(element, `button ${text}`).toBeDefined();
  return element!;
}

async function click(text: string) {
  await act(async () => button(text).click());
}

async function emitImport(status: NotebookImportStatus['status'], message?: string, notebookId = notebook.id) {
  await act(async () => {
    for (const handler of [...mocks.listeners]) handler({ notebookId, status, message });
  });
}

async function selectTemplate() {
  await click('选择场景模板');
  const option = host.querySelector<HTMLButtonElement>('[aria-label="场景模板"] button');
  expect(option).not.toBeNull();
  await act(async () => option!.click());
  await click('完成');
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.listeners.clear();
  for (const notice of getActionableNotices()) clearActionableNotice(notice.id);
  savedBoot = { experimental: false, isIntroductDisplayed: false, isOnboardingCompleted: false };
  mocks.getFeatures.mockImplementation(async () => ({ ...savedBoot }));
  mocks.setOnboardingCompleted.mockImplementation(async () => { savedBoot.isOnboardingCompleted = true; });
  mocks.create.mockResolvedValue(notebook);
  mocks.list.mockResolvedValue([notebook]);
  mocks.getDefaultPath.mockResolvedValue(notebook.path);
  mocks.getImportStatus.mockResolvedValue({ notebookId: notebook.id, status: 'started' });
  mocks.getTemplateSetupStatus.mockResolvedValue(null);
  mocks.startImport.mockResolvedValue(undefined);
  mocks.selectNotebook.mockImplementation(async (book: NotebookRecord) => {
    useNoteStore.setState({ selectedNotebook: book });
  });
  useNoteStore.setState({ selectedNotebook: null });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  for (const notice of getActionableNotices()) clearActionableNotice(notice.id);
  mocks.listeners.clear();
});

describe('first-run notebook setup', () => {
  it('suppresses the ordinary create screen while boot is pending and enters the workspace with one create', async () => {
    let resolveBoot!: (features: BootFeatures) => void;
    mocks.getFeatures.mockReturnValueOnce(new Promise<BootFeatures>((resolve) => { resolveBoot = resolve; }));
    await mount();
    expect(host.querySelector('[data-ordinary-create]')).toBeNull();
    await act(async () => resolveBoot(savedBoot));
    expect(host.querySelector('#flowix-onboarding-notebook-form')).not.toBeNull();
    expect(host.textContent).not.toContain('接入 Agent');

    await click('创建并开始使用');
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.startImport).toHaveBeenCalledWith(notebook.id);
    expect(savedBoot.isOnboardingCompleted).toBe(true);
    expect(host.querySelector('#flowix-onboarding-notebook-form')).toBeNull();
    expect(host.querySelector('[data-ordinary-create]')).toBeNull();
    expect(host.querySelector('[data-workspace]')).not.toBeNull();
    expect(host.querySelector('[data-product-intro]')).not.toBeNull();
    await emitImport('completed');
    expect(getActionableNotices()).toHaveLength(0);
    expect(mocks.listeners.size).toBe(0);
  });

  it('does not bring Agent onboarding back on the next launch even if the legacy intro flag is false', async () => {
    await mount();
    await click('创建并开始使用');
    await emitImport('completed');
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount();
    expect(savedBoot.isIntroductDisplayed).toBe(false);
    expect(host.querySelector('#flowix-onboarding-notebook-form')).toBeNull();
    expect(host.querySelector('[data-ordinary-create]')).toBeNull();
    expect(host.querySelector('[data-agent-intro]')).toBeNull();
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it('keeps creation failures retryable without recording completion', async () => {
    mocks.create.mockRejectedValueOnce(new Error('PATH_CREATE_FAILED'));
    await mount();
    await click('创建并开始使用');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('PATH_CREATE_FAILED');
    expect(mocks.setOnboardingCompleted).not.toHaveBeenCalled();
    expect(mocks.startImport).not.toHaveBeenCalled();
    await click('创建并开始使用');
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(savedBoot.isOnboardingCompleted).toBe(true);
  });

  it('retries workspace selection with the registered notebook instead of creating a second one', async () => {
    mocks.selectNotebook.mockRejectedValueOnce(new Error('NOTEBOOK_UNAVAILABLE'));
    await mount();
    await click('创建并开始使用');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('NOTEBOOK_UNAVAILABLE');
    expect(mocks.setOnboardingCompleted).not.toHaveBeenCalled();
    expect(mocks.startImport).not.toHaveBeenCalled();
    await click('重试');
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.selectNotebook).toHaveBeenCalledTimes(2);
    expect(mocks.selectNotebook).toHaveBeenLastCalledWith(notebook);
    expect(host.querySelector('[data-ordinary-create]')).toBeNull();
  });

  it('keeps the wizard open if import startup IPC fails and reuses the notebook on retry', async () => {
    mocks.startImport.mockRejectedValueOnce(new Error('IMPORT_START_FAILED'));
    await mount();
    await click('创建并开始使用');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('IMPORT_START_FAILED');
    expect(mocks.setOnboardingCompleted).not.toHaveBeenCalled();
    expect(mocks.listeners.size).toBe(0);
    await click('重试');
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.startImport).toHaveBeenCalledTimes(2);
    expect(savedBoot.isOnboardingCompleted).toBe(true);
  });

  it('does not dismiss setup when completion persistence fails', async () => {
    mocks.getImportStatus.mockResolvedValue({ notebookId: notebook.id, status: 'completed' });
    mocks.setOnboardingCompleted.mockRejectedValueOnce(new Error('BOOT_WRITE_FAILED'));
    await mount();
    await click('创建并开始使用');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('BOOT_WRITE_FAILED');
    expect(savedBoot.isOnboardingCompleted).toBe(false);
    expect(host.querySelector('[data-product-intro]')).toBeNull();
    await click('重试');
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(savedBoot.isOnboardingCompleted).toBe(true);
  });

  it('passes scene templates to deferred setup without starting the ordinary importer', async () => {
    await mount();
    await selectTemplate();
    await click('创建并开始使用');
    expect(mocks.create).toHaveBeenCalledWith('My Notebook', undefined, null, false, 'project', false);
    expect(mocks.startImport).not.toHaveBeenCalled();
    expect(savedBoot.isOnboardingCompleted).toBe(true);
    expect(host.querySelector('[data-ordinary-create]')).toBeNull();
  });

  it('keeps setup open when the user declines overwriting existing template files', async () => {
    mocks.create.mockRejectedValueOnce(new Error('NOTEBOOK_PRESET_OVERWRITE_CONFIRM_REQUIRED'));
    mocks.confirmPresetOverwrite.mockResolvedValue(false);
    await mount();
    await selectTemplate();
    await click('创建并开始使用');
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.setOnboardingCompleted).not.toHaveBeenCalled();
    expect(host.querySelector('#flowix-onboarding-notebook-form')).not.toBeNull();
    expect(button('创建并开始使用').disabled).toBe(false);
  });

  it('reuses a notebook registered during an interrupted previous attempt', async () => {
    mocks.create.mockRejectedValueOnce(new Error('PATH_ALREADY_REGISTERED'));
    mocks.getImportStatus.mockResolvedValue({ notebookId: notebook.id, status: 'completed' });
    await mount();
    await click('创建并开始使用');
    expect(mocks.selectNotebook).toHaveBeenCalledWith(notebook);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.startImport).not.toHaveBeenCalled();
    expect(savedBoot.isOnboardingCompleted).toBe(true);
  });

  it('offers a real retry button after background import failure and retries the original notebook', async () => {
    await mount();
    await click('创建并开始使用');
    await emitImport('failed', 'INDEX_WRITE_FAILED');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('INDEX_WRITE_FAILED');
    expect(button('重试').disabled).toBe(false);
    await act(async () => useNoteStore.setState({ selectedNotebook: { ...notebook, id: 'other-book' } }));
    await click('重试');
    expect(mocks.startImport).toHaveBeenCalledTimes(2);
    expect(mocks.startImport).toHaveBeenLastCalledWith(notebook.id);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.selectNotebook).toHaveBeenCalledTimes(1);
    await emitImport('completed', undefined, 'other-book');
    expect(getActionableNotices()).toHaveLength(1);
    await emitImport('completed');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(mocks.listeners.size).toBe(0);
  });

  it('retains retry after another import failure or a retry IPC error', async () => {
    await mount();
    await click('创建并开始使用');
    await emitImport('failed', 'FIRST_FAILURE');
    mocks.startImport.mockRejectedValueOnce(new Error('RETRY_IPC_FAILED'));
    await click('重试');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('RETRY_IPC_FAILED');
    expect(button('重试').disabled).toBe(false);
    await click('重试');
    await emitImport('failed', 'SECOND_FAILURE');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('SECOND_FAILURE');
    await click('重试');
    await emitImport('completed');
    expect(getActionableNotices()).toHaveLength(0);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it('shows retry for a failure already reported by the status query, then clears it on a fast retry', async () => {
    mocks.getImportStatus.mockResolvedValueOnce({
      notebookId: notebook.id, status: 'failed', message: 'FAST_IMPORT_FAILURE',
    });
    await mount();
    await click('创建并开始使用');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('FAST_IMPORT_FAILURE');
    expect(mocks.listeners.size).toBe(0);
    mocks.getImportStatus.mockResolvedValueOnce({ notebookId: notebook.id, status: 'completed' });
    await click('重试');
    expect(mocks.startImport).toHaveBeenLastCalledWith(notebook.id);
    expect(mocks.startImport).toHaveBeenCalledTimes(2);
    expect(getActionableNotices()).toHaveLength(0);
    expect(mocks.listeners.size).toBe(0);
  });

  it('still offers ordinary notebook creation when setup is completed but no notebook remains', async () => {
    savedBoot.isOnboardingCompleted = true;
    await mount();
    expect(host.querySelector('[data-ordinary-create]')).not.toBeNull();
    expect(host.querySelector('#flowix-onboarding-notebook-form')).toBeNull();
    expect(host.querySelector('[data-agent-intro]')).toBeNull();
  });

  it('releases the empty-notebook fallback when the boot lookup fails', async () => {
    mocks.getFeatures.mockRejectedValueOnce(new Error('BOOT_UNAVAILABLE'));
    await mount();
    expect(host.querySelector('[data-ordinary-create]')).not.toBeNull();
    expect(host.querySelector('#flowix-onboarding-notebook-form')).toBeNull();
    expect(mocks.setOnboardingCompleted).not.toHaveBeenCalled();
  });
});
