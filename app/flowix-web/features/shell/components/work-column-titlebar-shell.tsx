'use client';

import type { CSSProperties, ReactNode } from 'react';
import { isMac } from '@features/shortcuts';
import { useI18n } from '@/lib/i18n';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@shared/ui/context-menu';
import { useWorkColumnTransferViewModel } from '@features/workspace/public/shell-api';
import { hideBrowserColumn } from '@features/workspace/public/browser-column-api';

/** Shared titlebar fade used by the work column and browser-column tabs. */
export const WORK_COLUMN_TITLEBAR_GRADIENT =
  'linear-gradient(to bottom, var(--bg-titlebar), transparent)';

interface WorkColumnTitlebarShellProps {
  isWindows: boolean;
  reserveWindowsControls?: boolean;
  showTrafficLightSpacer?: boolean;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

/** Shared frame for the work-column document and Agent titlebars. */
export function WorkColumnTitlebarShell({
  isWindows,
  reserveWindowsControls = true,
  showTrafficLightSpacer = false,
  className = '',
  style,
  children,
}: WorkColumnTitlebarShellProps) {
  const { t } = useI18n();
  const { canOpenInBrowserColumn, openInBrowserColumn } = useWorkColumnTransferViewModel();

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-tauri-drag-region
          className={`z-[50] flex shrink-0 select-none items-center pl-2 ${
            isWindows
              ? `h-9 ${reserveWindowsControls ? 'pr-[126px]' : 'pr-0'}`
              : 'h-12'
          } ${className}`}
          style={style}
        >
          {isMac() && showTrafficLightSpacer && (
            <div aria-hidden="true" className="h-full w-[88px] shrink-0" />
          )}
          {children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-[176px] space-y-0.5 rounded-xl p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
        <ContextMenuItem
          disabled={!canOpenInBrowserColumn}
          onClick={() => {
            if (canOpenInBrowserColumn) {
              void openInBrowserColumn();
            }
          }}
          className="h-7 items-center justify-start gap-0 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
        >
          <span className="leading-5">{t('workColumn.context.alsoOpenInBrowserColumn')}</span>
        </ContextMenuItem>
        <ContextMenuItem
          onClick={hideBrowserColumn}
          className="h-7 items-center justify-start gap-0 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
        >
          <span className="leading-5">{t('tabWindow.closeColumn')}</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
