import { Code2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { canOpenBrowserColumnTargetInWorkColumn, type BrowserColumnTab } from '@features/workspace/public/browser-column-api';
import { documentIdentityFromFile, useDocumentEditorMode } from '@features/document/public/shell-api';
import { requireFileDisplayIdentity } from '@/lib/file-display-registry';
import { ContextMenuContent, ContextMenuItem } from '@shared/ui/context-menu';
import { POPUP_SEPARATOR_CLASS } from '@shared/ui/popup-separator';

function MemoEditorModeContextMenuItem({
  filePath,
  onToggle,
}: {
  filePath: string;
  onToggle: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const editorMode = useDocumentEditorMode(
    'browser-column',
    documentIdentityFromFile(requireFileDisplayIdentity(filePath)),
  );

  return (
    <ContextMenuItem
      onClick={() => { void onToggle(); }}
      className="h-7 items-center justify-start gap-0 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
    >
      <Code2 className="mr-2 h-4 w-4" />
      <span className="leading-5">
        {editorMode === 'source'
          ? t('document.action.richTextMode')
          : t('document.action.sourceMode')}
      </span>
    </ContextMenuItem>
  );
}

type TabAction = (tabId: string) => void | Promise<void>;

interface BrowserTabContextMenuProps {
  tab: BrowserColumnTab;
  index: number;
  tabCount: number;
  onCloseTab: TabAction;
  onCloseOtherTabs: TabAction;
  onCloseTabsToRight: TabAction;
  onCloseAllTabs: () => void | Promise<void>;
  onToggleMemoEditorMode: TabAction;
  onOpenTabInWorkColumn: TabAction;
}

export function BrowserTabContextMenu({
  tab, index, tabCount, onCloseTab, onCloseOtherTabs, onCloseTabsToRight,
  onCloseAllTabs, onToggleMemoEditorMode, onOpenTabInWorkColumn,
}: BrowserTabContextMenuProps) {
  const { t } = useI18n();
  const workOpenUnavailableReason = tab.target.kind === 'file-browser' && !tab.target.activeFilePath
    ? t('tabWindow.context.moveFolderUnavailable')
    : null;
  return (
    <ContextMenuContent className="w-[180px] space-y-0.5 rounded-xl p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
      <ContextMenuItem
        onClick={() => onCloseTab(tab.id)}
        className="h-7 items-center justify-start gap-0 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
      >
        <span className="leading-5">{t('tabWindow.context.close')}</span>
      </ContextMenuItem>
      <ContextMenuItem
        disabled={tabCount <= 1}
        onClick={() => onCloseOtherTabs(tab.id)}
        className="h-7 items-center justify-start gap-0 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
      >
        <span className="leading-5">{t('tabWindow.context.closeOther')}</span>
      </ContextMenuItem>
      <ContextMenuItem
        disabled={index === tabCount - 1}
        onClick={() => onCloseTabsToRight(tab.id)}
        className="h-7 items-center justify-start gap-0 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
      >
        <span className="leading-5">{t('tabWindow.context.closeRight')}</span>
      </ContextMenuItem>
      <ContextMenuItem
        onClick={onCloseAllTabs}
        className="h-7 items-center justify-start gap-0 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
      >
        <span className="leading-5">{t('tabWindow.context.closeAll')}</span>
      </ContextMenuItem>
      {tab.target.kind === 'file-browser' && tab.target.activeFilePath && /\.md$/i.test(tab.target.activeFilePath) && (
        <MemoEditorModeContextMenuItem
          filePath={tab.target.activeFilePath}
          onToggle={() => onToggleMemoEditorMode(tab.id)}
        />
      )}
      <div
        role="separator"
        aria-hidden="true"
        className={POPUP_SEPARATOR_CLASS}
      />
      <ContextMenuItem
        aria-describedby={workOpenUnavailableReason ? `move-unavailable-${tab.id}` : undefined}
        disabled={!canOpenBrowserColumnTargetInWorkColumn(tab.target)}
        onClick={() => onOpenTabInWorkColumn(tab.id)}
        className="h-7 items-center justify-start gap-0 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
      >
        <span className="leading-5">{t('tabWindow.context.openInWorkColumn')}</span>
      </ContextMenuItem>
      {workOpenUnavailableReason && (
        <p id={`move-unavailable-${tab.id}`} className="px-2 py-1 text-xs leading-5 text-[var(--muted-foreground)]">
          {workOpenUnavailableReason}
        </p>
      )}
    </ContextMenuContent>
  );
}
