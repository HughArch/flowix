'use client';

import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import type { DocTreeItem, MediaLibraryListItem, TableDocumentListItem } from '@platform/tauri/client';
import { TREE_EDGE_GUTTER } from './notebook-tree-layout';

interface SectionFrameProps {
  order: number;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  sectionActions?: ReactNode;
}

interface NotebookPinnedSectionProps extends SectionFrameProps {
  items: DocTreeItem[];
  renderItem: (item: DocTreeItem) => ReactNode;
}

export function NotebookPinnedSection({
  order,
  collapsed,
  onToggleCollapsed,
  sectionActions,
  items,
  renderItem,
}: NotebookPinnedSectionProps) {
  const { t } = useI18n();

  return (
    <section
      className="pb-3"
      aria-label={t('memo.fileTree.pinnedSectionTitle')}
      data-notebook-pinned-section="true"
      style={{ order }}
    >
      <div
        className="notebook-file-tree__section-header group mb-0.5 flex h-7 items-center rounded-lg px-1.5 transition-colors hover:bg-[var(--muted)]"
        style={{ marginLeft: TREE_EDGE_GUTTER, width: `calc(100% - ${TREE_EDGE_GUTTER * 2}px)` }}
      >
        <button
          type="button"
          className="flex h-full items-center gap-0.5 text-[0.82rem] font-medium text-[var(--muted-foreground)] opacity-90 hover:text-[var(--foreground)] focus-visible:outline-none"
          aria-label={t(collapsed ? 'memo.fileTree.expandPinned' : 'memo.fileTree.collapsePinned')}
          title={t(collapsed ? 'memo.fileTree.expandPinned' : 'memo.fileTree.collapsePinned')}
          onClick={onToggleCollapsed}
        >
          <span>{t('memo.fileTree.pinnedSectionTitle')}</span>
          <ChevronRight className={cn(
            'h-3.5 w-3.5 opacity-0 transition-[opacity,transform] group-hover:opacity-100 group-focus-within:opacity-100',
            collapsed && 'opacity-100',
            !collapsed && 'rotate-90',
          )} />
        </button>
        <div className="ml-auto flex items-center">{sectionActions}</div>
      </div>
      {!collapsed && <div className="flex flex-col gap-0.5">{items.map(renderItem)}</div>}
    </section>
  );
}

interface NotebookViewsSectionProps extends SectionFrameProps {
  tables: TableDocumentListItem[];
  mediaLibraries: MediaLibraryListItem[];
  renderTable: (item: TableDocumentListItem) => ReactNode;
  renderMediaLibrary: (item: MediaLibraryListItem) => ReactNode;
}

export function NotebookViewsSection({
  order,
  collapsed,
  onToggleCollapsed,
  sectionActions,
  tables,
  mediaLibraries,
  renderTable,
  renderMediaLibrary,
}: NotebookViewsSectionProps) {
  const { t } = useI18n();

  return (
    <section
      className="pb-3"
      aria-label={t('memo.fileTree.viewsSectionTitle')}
      data-notebook-views-section="true"
      style={{ order }}
    >
      <div
        className="notebook-file-tree__section-header group mb-0.5 flex h-7 items-center rounded-lg px-1.5 transition-colors hover:bg-[var(--muted)]"
        style={{ marginLeft: TREE_EDGE_GUTTER, width: `calc(100% - ${TREE_EDGE_GUTTER * 2}px)` }}
      >
        <button
          type="button"
          className="flex h-full items-center gap-0.5 text-[0.82rem] font-medium text-[var(--muted-foreground)] opacity-90 hover:text-[var(--foreground)] focus-visible:outline-none"
          aria-label={t(collapsed ? 'memo.fileTree.expandViews' : 'memo.fileTree.collapseViews')}
          title={t(collapsed ? 'memo.fileTree.expandViews' : 'memo.fileTree.collapseViews')}
          onClick={onToggleCollapsed}
        >
          <span>{t('memo.fileTree.viewsSectionTitle')}</span>
          <ChevronRight className={cn(
            'h-3.5 w-3.5 opacity-0 transition-[opacity,transform] group-hover:opacity-100 group-focus-within:opacity-100',
            collapsed && 'opacity-100',
            !collapsed && 'rotate-90',
          )} />
        </button>
        <div className="ml-auto flex items-center">{sectionActions}</div>
      </div>
      {!collapsed && <div className="space-y-0.5">
        {tables.map(renderTable)}
        {mediaLibraries.map(renderMediaLibrary)}
      </div>}
    </section>
  );
}
