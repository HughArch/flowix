import { isMac } from '@features/shortcuts';
import { useI18n } from '@/lib/i18n';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@shared/ui/context-menu';
import { useWorkColumnTransferViewModel } from '@features/workspace/public/shell-api';
import { hideBrowserColumn } from '@features/workspace/public/browser-column-api';
import { WorkColumnTitlebarShell, type WorkColumnTitlebarShellProps } from './work-column-titlebar-shell';

/** Main work-column menu coordinates host actions around the visual frame. */
export function WorkColumnTitlebar(props: WorkColumnTitlebarShellProps) {
  const { t } = useI18n();
  const { canOpenInBrowserColumn, openInBrowserColumn } = useWorkColumnTransferViewModel();
  const itemClass = 'h-7 items-center justify-start gap-0 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]';
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild><WorkColumnTitlebarShell {...props}
        showTrafficLightSpacer={isMac() && props.showTrafficLightSpacer} /></ContextMenuTrigger>
      <ContextMenuContent className="w-[176px] space-y-0.5 rounded-xl p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
        <ContextMenuItem disabled={!canOpenInBrowserColumn} className={itemClass}
          onClick={() => { if (canOpenInBrowserColumn) void openInBrowserColumn(); }}>
          <span className="leading-5">{t('workColumn.context.alsoOpenInBrowserColumn')}</span>
        </ContextMenuItem>
        <ContextMenuItem onClick={hideBrowserColumn} className={itemClass}>
          <span className="leading-5">{t('tabWindow.closeColumn')}</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
