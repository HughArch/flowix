'use client';

import { useEffect, useState } from 'react';
import { ChevronRight, CircleAlert, LoaderCircle } from 'lucide-react';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { NotebookIconPopover } from '@features/memo/components/notebook-icon-popover';
import { dialogs, notebooks, type NotebookRecord } from '@platform/tauri/client';
import { createNotebookRegistration, notebookRepository } from '@features/memo/services';
import { useNoteStore } from '@features/memo/store/note-store';
import { useI18n } from '@/lib/i18n';
import { WindowsTitlebarControls } from '@shared/window-titlebar-controls';
import { isMac } from '@features/shortcuts';
import { useNotebookTemplates } from './notebook-templates';
import { NotebookTemplateCardPreview, NotebookTemplateEmptyCard, NotebookTemplatePicker } from './notebook-template-picker';
import { OnboardingTitlebarMac } from './onboarding-titlebar-mac';

const DEFAULT_BOOK_FOLDER = 'My Notebook';
const DEFAULT_NOTEBOOK_NAME = 'My Notebook';

function defaultFolderNameForNotebook(name: string): string {
  const trimmed = name.trim();
  return !trimmed || trimmed === DEFAULT_NOTEBOOK_NAME ? DEFAULT_BOOK_FOLDER : trimmed;
}

interface OnboardingScreenProps {
  onFinish(notebook: NotebookRecord, options: { startImport: boolean }): Promise<void>;
}

export function OnboardingScreen({ onFinish }: OnboardingScreenProps) {
  const { t } = useI18n();
  const {
    templates: notebookTemplates,
    status: notebookTemplateStatus,
    retry: retryNotebookTemplates,
  } = useNotebookTemplates();
  const [isTemplatePickerOpen, setIsTemplatePickerOpen] = useState(false);
  const [defaultPath, setDefaultPath] = useState<string | null>(null);
  const [notebookName, setNotebookName] = useState(DEFAULT_NOTEBOOK_NAME);
  const [notebookPath, setNotebookPath] = useState<string | null>(null);
  const [notebookIcon, setNotebookIcon] = useState<string | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
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
      await onFinish(notebook, { startImport });
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
      let registration: Awaited<ReturnType<typeof createNotebookRegistration>>;
      try {
        registration = await createNotebookRegistration({
          name,
          path: notebookPath ?? undefined,
          icon: notebookIcon,
          templateId: selectedTemplateId,
          reuseExisting: true,
        });
      } catch (value) {
        if (
          !selectedTemplateId
          || !String(value).includes('NOTEBOOK_PRESET_OVERWRITE_CONFIRM_REQUIRED')
        ) {
          throw value;
        }
        if (!await notebookRepository.confirmPresetOverwrite(t('notebook.template.overwriteConfirm'))) return;
        registration = await createNotebookRegistration({
          name,
          path: notebookPath ?? undefined,
          icon: notebookIcon,
          templateId: selectedTemplateId,
          overwriteExisting: true,
          reuseExisting: true,
        });
      }

      const notebook = registration.notebook;
      setDefaultPath(notebook.path);
      const latest = await notebookRepository.list();
      useNoteStore.getState().setNotebooks(latest);
      const startImport = registration.needsImport && !registration.hasTemplateSetup;
      setCreatedNotebook(notebook);
      setShouldStartImport(startImport);
      await finishNotebook(notebook, startImport);
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
      className="fixed inset-0 z-[220] flex flex-col overflow-hidden bg-[var(--frame-bg)] text-[var(--foreground)] [--onboarding-form-gap:22px] [--onboarding-ink:var(--foreground)] [--onboarding-subtle:var(--muted-foreground)] [--onboarding-panel:color-mix(in_oklch,var(--card)_96%,var(--background))] [--onboarding-line:color-mix(in_oklch,var(--border)_78%,transparent)] animate-[flowix-onboarding-in_520ms_cubic-bezier(0.16,1,0.3,1)_both] motion-reduce:animate-none max-[760px]:overflow-y-auto [&_button:focus-visible]:outline-2 [&_button:focus-visible]:outline-[var(--ring)] [&_button:focus-visible]:outline-offset-[3px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="flowix-onboarding-notebook-title"
    >
      {isMac() && <OnboardingTitlebarMac />}
      <WindowsTitlebarControls reserveSpace />
      <main className="relative z-[1] flex min-h-0 w-full flex-1 flex-col px-[clamp(28px,6vw,96px)] pb-[clamp(22px,3vw,44px)] max-[760px]:px-5 max-[760px]:pb-[26px]">
        <div className="mx-auto flex min-h-0 w-[min(100%,780px)] flex-1 flex-col items-start justify-center overflow-y-auto overscroll-contain">
          <section className="w-full animate-[flowix-onboarding-section-in_500ms_ease-out_both] motion-reduce:animate-none py-[clamp(11px,1.33vw,16px)] pb-4" aria-labelledby="flowix-onboarding-notebook-title">
            <div className="max-w-full">
              <h1 className="text-[clamp(23px,3.33vw,44px)] font-light leading-[0.98] tracking-[-0.065em] text-[var(--onboarding-ink)]" id="flowix-onboarding-notebook-title">创建你的第一个笔记本</h1>
              <p className="mt-6 max-w-full text-sm leading-[1.72] text-[var(--onboarding-subtle)]">填写笔记本名称和存储位置，也可以选择一个场景模板开始使用。</p>
            </div>
            <form
              id="flowix-onboarding-notebook-form"
              className="mt-[22px] grid w-[min(100%,780px)] grid-cols-[minmax(0,1fr)_320px] items-start gap-x-[22px] gap-y-4 p-0 max-[760px]:grid-cols-1"
              onSubmit={(event) => {
                event.preventDefault();
                void createNotebook();
              }}
            >
              <div className="grid min-w-0 content-start gap-4 pr-[38px] max-[760px]:pr-0">
                <div className="grid min-w-0 gap-1">
                  <label className="text-sm font-semibold text-[var(--foreground)]" htmlFor="flowix-onboarding-notebook-name">笔记本名称</label>
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                    <Input
                      id="flowix-onboarding-notebook-name"
                      value={notebookName}
                      onChange={(event) => setNotebookName(event.target.value)}
                      autoFocus
                      className="h-10 bg-[var(--card)]"
                      disabled={Boolean(createdNotebook) || isCreatingNotebook || isFinishing}
                    />
                    <NotebookIconPopover
                      value={notebookIcon}
                      notebookName={notebookName}
                      onChange={setNotebookIcon}
                    />
                  </div>
                </div>
                <div className="grid min-w-0 gap-1">
                  <label className="text-sm font-semibold text-[var(--foreground)]" htmlFor="flowix-onboarding-notebook-path">存储位置</label>
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                    <Input
                      id="flowix-onboarding-notebook-path"
                      value={notebookPath ?? defaultPath ?? ''}
                      placeholder="文档 / flowix / My Notebook"
                      disabled
                      readOnly
                      className="h-10 min-w-0 bg-[var(--card)]"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      className="h-10 shrink-0 bg-[var(--card)]"
                      onClick={() => void selectNotebookDirectory()}
                      disabled={Boolean(createdNotebook) || isCreatingNotebook || isFinishing}
                    >
                      选择目录
                    </Button>
                  </div>
                </div>
              </div>
              <div className="grid min-w-0 content-start gap-1">
                <button
                  type="button"
                  className="flex w-full items-center justify-start gap-0.5 p-0 text-left text-sm font-semibold text-[var(--foreground)] hover:text-[var(--brand)]"
                  aria-haspopup="dialog"
                  onClick={() => setIsTemplatePickerOpen(true)}
                  disabled={Boolean(createdNotebook) || isCreatingNotebook || isFinishing}
                >
                  <span>选择场景模板（可选）</span>
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
                {notebookTemplates.find((template) => template.id === selectedTemplateId) && (
                  <NotebookTemplateCardPreview
                    template={notebookTemplates.find((template) => template.id === selectedTemplateId)!}
                    onSwitch={() => setIsTemplatePickerOpen(true)}
                  />
                )}
                {!selectedTemplateId && (
                  <NotebookTemplateEmptyCard onClick={() => setIsTemplatePickerOpen(true)} />
                )}
              </div>
            </form>
          </section>

          {error && (
            <div className="mt-5 flex items-start gap-[7px] text-xs leading-[1.5] text-[var(--destructive)]" role="alert"><CircleAlert size={15} aria-hidden="true" /> {error}</div>
          )}
        </div>

        <div className="sticky bottom-0 z-[2] mx-auto flex min-h-[62px] w-[min(100%,780px)] flex-[0_0_auto] items-center justify-end gap-[18px] border-t border-[var(--onboarding-line)] bg-[var(--frame-bg)] pt-[18px] max-[760px]:min-h-[58px] max-[760px]:pt-[14px]">
          <button
            type="submit"
            form="flowix-onboarding-notebook-form"
            className="inline-flex min-h-[38px] items-center justify-center gap-1 rounded-[9px] border border-[var(--brand)] bg-[var(--brand)] px-[15px] text-xs font-semibold text-[var(--primary-foreground)] shadow-[0_8px_18px_color-mix(in_oklch,var(--brand)_18%,transparent)] transition-transform hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-[0.46] max-[760px]:flex-1"
            disabled={isCreatingNotebook || isFinishing || !notebookName.trim() || (!createdNotebook && !notebookPath && !defaultPath)}
          >
            {isCreatingNotebook || isFinishing
              ? <><LoaderCircle size={17} className="flowix-spin" aria-hidden="true" /> 正在进入</>
              : <>{createdNotebook ? t('error.retry') : '创建并开始使用'} <ChevronRight size={14} className="-ml-1" aria-hidden="true" /></>}
          </button>
        </div>
        {isTemplatePickerOpen && (
          <NotebookTemplatePicker
            templates={notebookTemplates}
            status={notebookTemplateStatus}
            retry={retryNotebookTemplates}
            initialTemplateId={selectedTemplateId}
            onCancel={() => setIsTemplatePickerOpen(false)}
            onComplete={(templateId) => {
              setSelectedTemplateId(templateId);
              setIsTemplatePickerOpen(false);
            }}
          />
        )}
      </main>
    </div>
  );
}
