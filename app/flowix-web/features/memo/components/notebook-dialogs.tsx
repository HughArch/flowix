'use client';

import { Input } from '@shared/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@shared/ui/dialog';
import {
  getNotebookIconOption,
} from '@features/memo/components/notebook-icon';
import {
  NOTEBOOK_CREATE_PAGE_GUTTER_CLASS,
  NotebookCreateFooter,
  NotebookCreateForm,
} from '@features/memo/components/notebook-create-form';
import { NotebookIconPicker } from '@features/memo/components/notebook-icon-picker';
import type { Notebook } from '@features/memo/store/note-store';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { Loader2 } from 'lucide-react';
import { WindowsTitlebarControls } from '@shared/window-titlebar-controls';
import { isMac } from '@features/shortcuts';
import { OnboardingTitlebarMac } from '@features/onboarding/onboarding-titlebar-mac';

interface NotebookDialogsProps {
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
  newNotebookName: string;
  onNewNotebookNameChange: (name: string) => void;
  newNotebookPath: string;
  newNotebookDefaultPath: string;
  newNotebookIcon: string | null;
  onNewNotebookIconChange: (icon: string | null) => void;
  isCreatingNotebook: boolean;
  onSelectDirectory: () => Promise<void>;
  onConfirmCreate: () => void;
  onCancelCreate: () => void;
  editOpen: boolean;
  onEditOpenChange: (open: boolean) => void;
  editingNotebook: Notebook | null;
  editNotebookName: string;
  onEditNotebookNameChange: (name: string) => void;
  editNotebookIcon: string | null;
  onEditNotebookIconChange: (icon: string | null) => void;
  editSaving: boolean;
  onConfirmEdit: () => void;
  onCancelEdit: () => void;
}

function normalizeNotebookIconId(icon: string | null | undefined): string | null {
  return getNotebookIconOption(icon) ? icon! : null;
}

export function NotebookDialogs({
  createOpen,
  onCreateOpenChange,
  newNotebookName,
  onNewNotebookNameChange,
  newNotebookPath,
  newNotebookDefaultPath,
  newNotebookIcon,
  onNewNotebookIconChange,
  isCreatingNotebook,
  onSelectDirectory,
  onConfirmCreate,
  onCancelCreate,
  editOpen,
  onEditOpenChange,
  editingNotebook,
  editNotebookName,
  onEditNotebookNameChange,
  editNotebookIcon,
  onEditNotebookIconChange,
  editSaving,
  onConfirmEdit,
  onCancelEdit,
}: NotebookDialogsProps) {
  const { t } = useI18n();

  return (
    <>
      <Dialog open={createOpen} onOpenChange={onCreateOpenChange}>
        <DialogContent
          showCloseButton={false}
          aria-busy={isCreatingNotebook}
          aria-labelledby={'flowix-create-notebook-form-title'}
          className="!fixed !inset-0 !z-[130] !flex !h-dvh !max-h-none !w-full !max-w-none !flex-col !overflow-hidden !rounded-none !bg-[var(--frame-bg)] !p-0 !text-[var(--foreground)] !shadow-none [--onboarding-ink:var(--foreground)] [--onboarding-subtle:var(--muted-foreground)] [--onboarding-panel:color-mix(in_oklch,var(--card)_96%,var(--background))] [--onboarding-line:color-mix(in_oklch,var(--border)_78%,transparent)] [&_button:focus-visible]:outline-2 [&_button:focus-visible]:outline-[var(--ring)] [&_button:focus-visible]:outline-offset-[3px]"
        >
          {isMac() && <OnboardingTitlebarMac />}
          <WindowsTitlebarControls reserveSpace />
          <main className={cn(
            'relative z-[1] flex min-h-0 w-full flex-1 flex-col overflow-hidden',
            `${NOTEBOOK_CREATE_PAGE_GUTTER_CLASS} pb-[clamp(22px,3vw,44px)] max-[760px]:pb-[26px]`,
          )}>
            <div className={cn(
              'mx-auto flex min-h-0 w-full flex-1 flex-col overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
              'max-w-[680px]',
            )}>
              <section className="w-full py-[clamp(11px,1.33vw,16px)] pb-4 flex min-h-full flex-col justify-center">
                  <NotebookCreateForm
                    title="新建笔记本"
                    formId="flowix-create-notebook-form"
                    name={newNotebookName}
                    onNameChange={onNewNotebookNameChange}
                    nameLabel={t('notebook.create.namePlaceholder')}
                    namePlaceholder={t('notebook.create.namePlaceholder')}
                    pathLabel={t('notebook.create.pathLabel')}
                    path={newNotebookPath || newNotebookDefaultPath}
                    pathPlaceholder={t('notebook.create.pathPlaceholder')}
                    directoryButtonLabel={t('notebook.create.selectDirectory')}
                    onSelectDirectory={() => void onSelectDirectory()}
                    icon={newNotebookIcon}
                    onIconChange={onNewNotebookIconChange}
                    disabled={isCreatingNotebook}
                    onSubmit={onConfirmCreate}
                  />
              </section>
            </div>
            <NotebookCreateFooter
              formId="flowix-create-notebook-form"
              disabled={!newNotebookName.trim()}
              isBusy={isCreatingNotebook}
              cancelLabel={t('notebook.create.cancel')}
              onCancel={onCancelCreate}
            />
          </main>
        </DialogContent>
      </Dialog>
      <Dialog open={editOpen} onOpenChange={onEditOpenChange}>
        <DialogContent className="w-[390px] !max-w-[calc(100vw-2rem)]" aria-busy={editSaving}>
          <DialogHeader>
            <DialogTitle>{t("notebook.edit.title")}</DialogTitle>
          </DialogHeader>
          <div className="mt-2">
            <div className="min-w-0 space-y-3">
              <Input
                placeholder={t("notebook.edit.namePlaceholder")}
                value={editNotebookName}
                disabled={editSaving}
                onChange={(event) => onEditNotebookNameChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') onConfirmEdit();
                }}
                autoFocus
                className="h-10"
              />
              <NotebookIconPicker
                value={editNotebookIcon}
                notebookName={editNotebookName}
                onChange={onEditNotebookIconChange}
                disabled={editSaving}
              />
              <div className="space-y-2">
                <div className="text-sm font-semibold text-[var(--foreground)]">
                  {t("notebook.edit.pathLabel")}
                </div>
                <div
                  className="flex h-10 w-full items-center truncate rounded-lg border border-input bg-[var(--muted)] px-3 text-sm text-[var(--muted-foreground)] select-all"
                  title={editingNotebook?.path ?? ''}
                >
                  {editingNotebook?.path ?? ''}
                </div>
              </div>
            </div>
          </div>
          <div className="mt-4 flex items-center justify-between gap-2">
            {editingNotebook ? (
              <button
                type="button"
                disabled={editSaving}
                onClick={() => {
                  if (!editingNotebook) return;
                  const target = editingNotebook;
                  // 复用 main-layout 已有的 NotebookDeleteDialog:
                  // 先关掉当前弹窗, 再派发全局事件打开删除确认。
                  onCancelEdit();
                  window.dispatchEvent(
                    new CustomEvent<Notebook>('flowix:request-delete-notebook', { detail: target })
                  );
                }}
                className="h-8 px-3 text-sm rounded-lg bg-[var(--card)] text-[var(--foreground)] border border-[var(--border)] hover:bg-transparent hover:border-[var(--destructive)] hover:text-[var(--destructive)]"
              >
                {t("notebook.edit.remove")}
              </button>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onCancelEdit}
                disabled={editSaving}
                className="h-8 px-3 text-sm rounded-lg hover:bg-[var(--muted)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t("notebook.edit.cancel")}
              </button>
              <button
                type="button"
                onClick={onConfirmEdit}
                className="h-8 px-3 text-sm rounded-lg bg-[var(--primary)] text-[var(--primary-foreground)] hover:opacity-90 disabled:opacity-50"
                disabled={
                  editSaving ||
                  !editNotebookName.trim() ||
                  (editNotebookName.trim() === editingNotebook?.name &&
                    (editNotebookIcon ?? '') === (normalizeNotebookIconId(editingNotebook?.icon) ?? ''))
                }
              >
                {editSaving && <Loader2 className="mr-1.5 inline-block h-3.5 w-3.5 flowix-spin" />}
                {editSaving ? t("notebook.edit.saving") : t("notebook.edit.confirm")}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
