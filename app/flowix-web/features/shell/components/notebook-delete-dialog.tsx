'use client';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@shared/ui/dialog';
import { useI18n } from '@/lib/i18n';
import { useState } from 'react';

interface NotebookDeleteDialogProps {
  /** When non-null, the dialog is open and confirming will delete this notebook. */
  target: { id: string; name: string } | null;
  onCancel: () => void;
  onConfirm: (deleteLocalFiles: boolean) => void;
}

/**
 * Confirmation dialog for deleting a notebook.
 *
 * Local notebook files are kept unless the user explicitly checks the option.
 */
export function NotebookDeleteDialog({ target, onCancel, onConfirm }: NotebookDeleteDialogProps) {
  const { t } = useI18n();
  const [deleteLocalFiles, setDeleteLocalFiles] = useState(false);
  return (
    <Dialog
      open={!!target}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent className="rounded-xl border border-[var(--border-popup)] bg-[var(--card)] shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
        <DialogHeader>
          <DialogTitle>{t('notebook.delete.title')}</DialogTitle>
          <DialogDescription>{t('notebook.delete.description')}</DialogDescription>
        </DialogHeader>
        <div className="mt-4 flex items-center justify-between gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-[var(--foreground)]">
            <input
              type="checkbox"
              checked={deleteLocalFiles}
              onChange={(event) => setDeleteLocalFiles(event.currentTarget.checked)}
              className="h-4 w-4 accent-[var(--brand)]"
            />
            {t('notebook.delete.deleteLocalFiles')}
          </label>
          <div className="flex shrink-0 justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="h-8 px-3 text-sm rounded-lg hover:bg-[var(--muted)]"
            >
              {t('dialog.cancel')}
            </button>
            <button
              type="button"
              onClick={() => onConfirm(deleteLocalFiles)}
              className="h-8 rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 text-sm text-[var(--foreground)] hover:border-[var(--destructive)] hover:bg-transparent hover:text-[var(--destructive)]"
            >
              {t('dialog.delete')}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
