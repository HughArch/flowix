'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { canonicalDirectoryPath, canonicalPath, joinNotebookMemoPath } from '@/lib/path';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import folderIcon from '@/assets/folder-outline.svg?raw';
import {
  files,
  type DocTreeItem,
  type NotebookFolderOption,
} from '@platform/tauri/client';

/** 移动端「移动到…」的目标文件夹选择框。 */
export function NotebookMoveToFolderDialog({
  item,
  notebookPath,
  onClose,
  onMoveTo,
}: {
  item: DocTreeItem;
  notebookPath: string;
  onClose: () => void;
  onMoveTo: (targetDirectoryPath: string) => Promise<void> | void;
}) {
  const { t } = useI18n();
  const [options, setOptions] = useState<NotebookFolderOption[] | null>(null);
  const [selectedRelativePath, setSelectedRelativePath] = useState('');
  const [moving, setMoving] = useState(false);

  const itemPath = canonicalPath(item.fullPath);
  const candidateOptions = useMemo(() => (options ?? []).filter((option) => {
    const optionPath = canonicalPath(joinNotebookMemoPath(notebookPath, option.relativePath) ?? '');
    if (!optionPath || optionPath === itemPath) return false;
    // 文件夹不能移动到自身或其子文件夹里。
    if (item.type === 'folder' && optionPath.startsWith(`${itemPath}/`)) return false;
    return true;
  }), [item.type, itemPath, notebookPath, options]);

  useEffect(() => {
    let disposed = false;
    void files.getNotebookFolderOptions(notebookPath)
      .then((nextOptions) => {
        if (!disposed) setOptions(nextOptions);
      })
      .catch(() => {
        if (!disposed) setOptions([]);
      });
    return () => {
      disposed = true;
    };
  }, [notebookPath]);

  const confirmMove = useCallback(async () => {
    if (moving) return;
    const target = selectedRelativePath === ''
      ? canonicalDirectoryPath(notebookPath)
      : joinNotebookMemoPath(notebookPath, selectedRelativePath);
    if (!target) return;
    setMoving(true);
    try {
      await onMoveTo(target);
    } finally {
      setMoving(false);
    }
  }, [moving, notebookPath, onMoveTo, selectedRelativePath]);

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !moving) onClose(); }}>
      <DialogContent className="w-[min(360px,calc(100vw-32px))] rounded-xl border border-[var(--border-popup)] bg-[var(--card)] shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
        <DialogHeader>
          <DialogTitle>{t('memo.fileTree.moveDialog.title')}</DialogTitle>
        </DialogHeader>
        <div
          className="mt-1 max-h-[280px] min-h-[80px] overflow-y-auto rounded-lg border border-[var(--border)] p-1"
          role="listbox"
          aria-label={t('memo.fileTree.moveDialog.title')}
        >
          <button
            type="button"
            role="option"
            aria-selected={selectedRelativePath === ''}
            onClick={() => setSelectedRelativePath('')}
            className="flex h-8 w-full items-center gap-1.5 rounded-lg px-2 text-left text-sm transition-colors hover:bg-[var(--muted)]"
            style={{ backgroundColor: selectedRelativePath === '' ? 'var(--muted)' : undefined }}
          >
            <span className="text-xs text-[var(--muted-foreground)]">{t('memo.fileTree.moveDialog.rootOption')}</span>
          </button>
          {candidateOptions.map((option) => {
            const selected = option.relativePath === selectedRelativePath;
            return (
              <button
                key={option.relativePath}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => setSelectedRelativePath(option.relativePath)}
                className={cn(
                  'flex h-8 w-full items-center gap-1.5 rounded-lg px-2 text-left text-sm transition-colors hover:bg-[var(--muted)]',
                  selected && 'bg-[var(--muted)]',
                )}
                style={{ paddingLeft: 8 + option.depth * 14 }}
              >
                <span
                  aria-hidden="true"
                  className="relative flex h-[16px] w-[16px] shrink-0 items-center justify-center text-[color-mix(in_oklch,var(--foreground)_70%,black_30%)]"
                  dangerouslySetInnerHTML={{ __html: folderIcon }}
                />
                <span className="min-w-0 flex-1 truncate">{option.relativePath.split('/').pop()}</span>
              </button>
            );
          })}
          {options !== null && candidateOptions.length === 0 && (
            <div className="px-2 py-3 text-center text-xs text-[var(--muted-foreground)]">
              {t('memo.fileTree.moveDialog.noFolders')}
            </div>
          )}
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            disabled={moving}
            onClick={onClose}
            className="h-8 rounded-lg px-3 text-sm hover:bg-[var(--muted)]"
          >
            {t('dialog.cancel')}
          </button>
          <button
            type="button"
            disabled={moving}
            onClick={() => void confirmMove()}
            className="h-8 rounded-lg bg-[var(--brand)] px-3 text-sm text-[var(--primary-foreground)] hover:opacity-90 disabled:opacity-50"
          >
            {t('memo.fileTree.moveDialog.confirm')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
