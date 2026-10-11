import { DownloadSimpleIcon, FileIcon, FolderSimplePlusIcon, PlusIcon } from '@phosphor-icons/react';
import { GalleryHorizontalEnd, Table2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { ContextMenuItem, ContextMenuSeparator, ContextMenuSubmenu } from '@shared/ui/context-menu';
import type { TableViewType } from '@features/multidimensional-table/public/create-api';

const MENU_ITEM_CLASS =
  'group h-7 items-center justify-start rounded-lg px-2 py-0 text-left transition-colors hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]';

export function NotebookCreateContextMenuItems({
  onCreateNote,
  onCreateFolder,
  onCreateTable,
  onCreateMediaLibrary,
  onImport,
}: {
  onCreateNote: () => void;
  onCreateFolder: () => void;
  onCreateTable: (viewType?: TableViewType) => void;
  onCreateMediaLibrary: () => void;
  onImport?: () => void;
}) {
  const { t } = useI18n();

  return (
    <>
      <ContextMenuItem onClick={onCreateNote} className={MENU_ITEM_CLASS}>
        <FileIcon className="mr-2 h-4 w-4" aria-hidden="true" />
        {t('memo.fileTree.newNote')}
      </ContextMenuItem>
      <ContextMenuItem onClick={onCreateFolder} className={MENU_ITEM_CLASS}>
        <FolderSimplePlusIcon className="mr-2 h-4 w-4" aria-hidden="true" />
        {t('memo.fileTree.newFolder')}
      </ContextMenuItem>
      <ContextMenuSubmenu label={t('memo.create.more')} icon={<PlusIcon className="h-4 w-4" aria-hidden="true" />}>
        <ContextMenuItem onClick={() => onCreateTable()} className={MENU_ITEM_CLASS}>
          <Table2 className="mr-2 h-4 w-4" aria-hidden="true" />
          <span>{t('memo.create.table')}</span>
          <span className="ml-auto text-xs text-[var(--muted-foreground)] opacity-50 group-hover:text-[var(--primary-foreground)] group-focus-visible:text-[var(--primary-foreground)]">{t('memo.create.note')}</span>
        </ContextMenuItem>
        {([
          ['gallery', 'memo.create.newGallery'],
          ['kanban', 'memo.create.newKanban'],
          ['calendar', 'memo.create.newCalendar'],
        ] as const).map(([viewType, label]) => (
          <ContextMenuItem key={viewType} onClick={() => onCreateTable(viewType)} className={MENU_ITEM_CLASS}>
            <span className="mr-2 h-4 w-4 shrink-0" aria-hidden="true" />
            {t(label)}
            <span className="ml-auto text-xs text-[var(--muted-foreground)] opacity-50 group-hover:text-[var(--primary-foreground)] group-focus-visible:text-[var(--primary-foreground)]">{t('memo.create.note')}</span>
          </ContextMenuItem>
        ))}
        <ContextMenuItem onClick={onCreateMediaLibrary} className={MENU_ITEM_CLASS}>
          <GalleryHorizontalEnd className="mr-2 h-4 w-4" aria-hidden="true" />
          <span>{t('memo.create.mediaLibrary')}</span>
          <span className="ml-auto text-xs text-[var(--muted-foreground)] opacity-50 group-hover:text-[var(--primary-foreground)] group-focus-visible:text-[var(--primary-foreground)]">
            {t('memo.create.mediaImageShort')}/{t('memo.create.mediaVideoShort')}
          </span>
        </ContextMenuItem>
      </ContextMenuSubmenu>
      {onImport && <ContextMenuItem onClick={onImport} className={MENU_ITEM_CLASS}>
        <DownloadSimpleIcon className="mr-2 h-4 w-4" aria-hidden="true" />
        {t('memo.fileTree.import')}
      </ContextMenuItem>}
      <ContextMenuSeparator />
    </>
  );
}
