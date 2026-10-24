'use client';

import { useEffect, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import {
  NOTEBOOK_CREATE_PAGE_GUTTER_CLASS,
  NotebookCreateFooter,
  NotebookCreateForm,
} from '@features/memo/components/notebook-create-form';
import { dialogs, notebooks, type NotebookRecord } from '@platform/tauri/client';
import { createNotebookRegistration, notebookRepository } from '@features/memo/services';
import { useNoteStore } from '@features/memo/store/note-store';
import { useI18n } from '@/lib/i18n';
import { WindowsTitlebarControls } from '@shared/window-titlebar-controls';
import { isMobileDevice } from '@shared/platform';
import { isMac } from '@features/shortcuts';
import { OnboardingTitlebarMac } from './onboarding-titlebar-mac';

const DEFAULT_BOOK_FOLDER = 'My Notebook';
const DEFAULT_NOTEBOOK_NAME = 'My Notebook';

function defaultFolderNameForNotebook(name: string): string {
  const trimmed = name.trim();
  return !trimmed || trimmed === DEFAULT_NOTEBOOK_NAME ? DEFAULT_BOOK_FOLDER : trimmed;
}

interface OnboardingScreenProps {
  onFinish(notebook: NotebookRecord, options: { startImport: boolean; templateId?: string | null }): Promise<void>;
}

export function OnboardingScreen({ onFinish }: OnboardingScreenProps) {
  const { t } = useI18n();
  const isMobile = isMobileDevice();
  const [defaultPath, setDefaultPath] = useState<string | null>(null);
  const [notebookName, setNotebookName] = useState(DEFAULT_NOTEBOOK_NAME);
  const [notebookPath, setNotebookPath] = useState<string | null>(null);
  const [notebookIcon, setNotebookIcon] = useState<string | null>(null);
  const [createdNotebook, setCreatedNotebook] = useState<NotebookRecord | null>(null);
  const [shouldStartImport, setShouldStartImport] = useState(false);
  const [isCreatingNotebook, setIsCreatingNotebook] = useState(false);
  const [isFinishing, setIsFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (notebookPath) return;
    setDefaultPath(null);
    void notebooks.getDefaultPath(defaultFolderNameForNotebook(notebookName))
      .then(setDefaultPath)
      .catch(() => {
        // Keep the form usable in browser/dev shells where the native path API is unavailable.
      });
  }, [notebookName, notebookPath]);

  const finishNotebook = async (notebook: NotebookRecord, startImport: boolean) => {
    setIsFinishing(true);
    setError(null);
    try {
      // 场景模板入口已下线; templateId 恒为 null, 管线暂保留。
      await onFinish(notebook, { startImport, templateId: null });
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setIsFinishing(false);
    }
  };

  const createNotebook = async () => {
    if (createdNotebook) {
      await finishNotebook(createdNotebook, shouldStartImport);
      return;
    }

    const name = notebookName.trim();
    if (!name) return;
    setIsCreatingNotebook(true);
    setError(null);
    try {
      const registration = await createNotebookRegistration({
        name,
        path: notebookPath ?? undefined,
        icon: notebookIcon,
        reuseExisting: true,
      });

      const notebook = registration.notebook;
      setDefaultPath(notebook.path);
      const store = useNoteStore.getState();
      store.setNotebooks(store.notebooks.some((item) => item.id === notebook.id)
        ? store.notebooks.map((item) => item.id === notebook.id ? notebook : item)
        : [...store.notebooks, notebook]);
      const startImport = registration.needsImport;
      setCreatedNotebook(notebook);
      setShouldStartImport(startImport);
      await finishNotebook(notebook, startImport);
      void notebookRepository.list()
        .then((latest) => useNoteStore.getState().setNotebooks(latest))
        .catch((value) => console.warn('[Onboarding] Failed to refresh notebook list:', value));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setIsCreatingNotebook(false);
    }
  };

  const selectNotebookDirectory = async () => {
    const path = await dialogs.selectDirectory();
    if (path) {
      setNotebookPath(path);
      setError(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[220] flex flex-col overflow-hidden bg-[var(--frame-bg)] text-[var(--foreground)] [--onboarding-ink:var(--foreground)] [--onboarding-subtle:var(--muted-foreground)] [--onboarding-panel:color-mix(in_oklch,var(--card)_96%,var(--background))] [--onboarding-line:color-mix(in_oklch,var(--border)_78%,transparent)] animate-[flowix-onboarding-in_520ms_cubic-bezier(0.16,1,0.3,1)_both] motion-reduce:animate-none max-[760px]:overflow-y-auto [&_button:focus-visible]:outline-2 [&_button:focus-visible]:outline-[var(--ring)] [&_button:focus-visible]:outline-offset-[3px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="flowix-onboarding-notebook-form-title"
    >
      {isMac() && <OnboardingTitlebarMac />}
      <WindowsTitlebarControls reserveSpace />
      <main className={`relative z-[1] flex min-h-0 w-full flex-1 flex-col ${NOTEBOOK_CREATE_PAGE_GUTTER_CLASS} pb-[clamp(22px,3vw,44px)] max-[760px]:pb-[26px]`}>
        <div className="mx-auto flex min-h-0 w-[min(100%,680px)] flex-1 flex-col items-start justify-center overflow-y-auto overscroll-contain">
          <section className="w-full animate-[flowix-onboarding-section-in_500ms_ease-out_both] motion-reduce:animate-none py-[clamp(11px,1.33vw,16px)] pb-4" aria-labelledby="flowix-onboarding-notebook-form-title">
            <NotebookCreateForm
              title="创建第一个笔记本"
              formId="flowix-onboarding-notebook-form"
              name={notebookName}
              onNameChange={setNotebookName}
              nameLabel="笔记本名称"
              pathLabel="存储位置"
              path={notebookPath ?? defaultPath ?? ''}
              pathPlaceholder="默认文稿位置"
              directoryButtonLabel="选择目录"
              onSelectDirectory={isMobile ? undefined : () => void selectNotebookDirectory()}
              hidePathSection={isMobile}
              icon={notebookIcon}
              onIconChange={setNotebookIcon}
              disabled={Boolean(createdNotebook) || isCreatingNotebook || isFinishing}
              onSubmit={() => void createNotebook()}
            />
          </section>

          {error && (
            <div className="mt-5 flex items-start gap-[7px] text-xs leading-[1.5] text-[var(--destructive)]" role="alert"><CircleAlert size={15} aria-hidden="true" /> {error}</div>
          )}
        </div>

        <NotebookCreateFooter
          formId="flowix-onboarding-notebook-form"
          disabled={!notebookName.trim() || (!createdNotebook && !isMobile && !notebookPath && !defaultPath)}
          isBusy={isCreatingNotebook || isFinishing}
          submitLabel={createdNotebook ? t('error.retry') : '创建并开始使用'}
        />
      </main>
    </div>
  );
}
