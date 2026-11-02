'use client';

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { useI18n } from '@/lib/i18n';

export function FolderCollectionSwitchConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  confirmDisabled = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  confirmDisabled?: boolean;
}) {
  const { t } = useI18n();

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>是否确认切换？</DialogTitle>
        <DialogDescription>切换后，当前集合的展示规则会重置</DialogDescription>
      </DialogHeader>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={() => onOpenChange(false)} className="h-8 rounded-lg px-3 text-sm hover:bg-[var(--muted)]">
          {t('dialog.cancel')}
        </button>
        <button type="button" disabled={confirmDisabled} onClick={onConfirm}
          className="h-8 rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 text-sm hover:bg-[var(--muted)] disabled:opacity-50">
          确认切换
        </button>
      </div>
    </DialogContent>
  </Dialog>;
}
