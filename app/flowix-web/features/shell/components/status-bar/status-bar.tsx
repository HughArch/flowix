'use client';

import { useEffect, useRef, useState } from 'react';
import { Info, ListTodo } from 'lucide-react';
import { ArrowsClockwiseIcon } from '@phosphor-icons/react';
import type { CSSProperties } from 'react';
import mcpPluginIcon from '@/assets/mcp-plugin.svg';
import { Tooltip } from '@shared/ui/tooltip';
import type { Notebook } from '@features/memo/store/note-store';
import { NotebookSelectorPopup } from '@features/shell/components/status-bar/notebook-selector-popup';
import { ProductUpdatePill } from '@features/shell/components/status-bar/product-update-pill';
import { ProductIntroDialog } from '@features/shell/components/status-bar/product-intro-dialog';
import {
  AgentConversationStatusBar,
  AgentIcon,
  createAndOpenPiConversation,
} from '@features/agent/public/shell-api';
import { useAgentRuntimeStore } from '@features/agent/store/agent-runtime-store';
import { normalizeAgentRuntimeStatus } from '@features/agent/runtime/agent-runtime-status';
import { useI18n } from '@/lib/i18n';
import { useDocumentMetricsStore } from '@features/document/store/document-metrics-store';
import { useNoteStore } from '@features/memo/store/note-store';
import { TagSvgIcon } from '@shared/ui/tag-icon';
import type { AppUpdaterState } from '@features/shell/hooks/use-app-updater';
import { useSyncPanelStore } from '@features/sync-status';

interface StatusBarProps {
  onSelectNotebook: (notebook: Notebook) => void;
  onEditNotebook: (notebook: Notebook) => void;
  onDeleteNotebook: (notebook: Notebook) => void;
  onCreateNotebook: () => void;
  onOpenTodos: () => void;
  onOpenTagPanel: () => void;
  productIntroOpen: boolean;
  onProductIntroOpenChange: (open: boolean) => void;
  onOpenMcpPreferences: () => void;
  updater: AppUpdaterState;
}

function PiRuntimeStatusIndicator() {
  const { t } = useI18n();
  const piStatus = useAgentRuntimeStore((state) => state.statusByType.pi);
  const isChecking = useAgentRuntimeStore((state) => state.isChecking);

  const runtimeStatus = normalizeAgentRuntimeStatus(piStatus, isChecking);
  const statusText = runtimeStatus.state === 'ready'
    ? t('agent.status.available')
    : runtimeStatus.state === 'checking'
      ? t('agent.status.checking')
      : runtimeStatus.state === 'unknown'
        ? t('agent.status.notChecked')
        : t('agent.status.setup');
  const label = `${t('agent.types.pi.name')} · ${statusText}`;

  return (
    <Tooltip content={label} side="top">
      <button
        type="button"
        onClick={createAndOpenPiConversation}
        className="h-full flex items-center justify-center px-1.5 py-0 hover:bg-[var(--muted)]"
        aria-label={label}
      >
        <AgentIcon typeKey="pi" alt="" className="h-3.5 w-3.5" />
      </button>
    </Tooltip>
  );
}

/**
 * Bottom status bar for the main window.
 *
 * Layout (two columns):
 *   [NotebookSwitcher] | [Todos] [char count]   …flex spacer…   [Note Nav] [AI Chat] [⚙]
 *
 * The left column is the notebook switcher (fixed width by its own button
 * content); the right column takes the remaining width for the status actions.
 *
 * Renders no chrome of its own — it assumes it lives in a `h-[26px]` flex strip.
 */
export function StatusBar({
  onSelectNotebook,
  onEditNotebook,
  onDeleteNotebook,
  onCreateNotebook,
  onOpenTodos,
  onOpenTagPanel,
  productIntroOpen,
  onProductIntroOpenChange,
  onOpenMcpPreferences,
  updater,
}: StatusBarProps) {
  const { t } = useI18n();
  const statusBarRightEdgeRef = useRef<HTMLDivElement>(null);
  const [notebookPopupOpen, setNotebookPopupOpen] = useState(false);
  const notebooks = useNoteStore((state) => state.notebooks);
  const selectedNotebook = useNoteStore((state) => state.selectedNotebook);
  const setNotebooks = useNoteStore((state) => state.setNotebooks);
  const charCount = useDocumentMetricsStore((state) => state.charCount);

  useEffect(() => {
    const handleToggle = () => setNotebookPopupOpen((open) => !open);
    window.addEventListener('flowix:toggle-notebook-switcher', handleToggle);
    return () => window.removeEventListener('flowix:toggle-notebook-switcher', handleToggle);
  }, []);

  return (
    <div className="flex h-[26px] shrink-0 select-none items-stretch text-xs text-[var(--muted-foreground)]">
      {/* Left column: notebook switcher (fixed width by its own button content). */}
      <div className="shrink-0 flex items-center">
        <NotebookSelectorPopup
          open={notebookPopupOpen}
          onOpenChange={setNotebookPopupOpen}
          notebooks={notebooks}
          selectedNotebook={selectedNotebook}
          onSelect={onSelectNotebook}
          onEdit={onEditNotebook}
          onDelete={onDeleteNotebook}
          onCreateNotebook={onCreateNotebook}
          onRefresh={setNotebooks}
        />
      </div>
      {/* Right column: full-width content area. */}
      <div ref={statusBarRightEdgeRef} className="flex-1 min-w-0 flex items-center gap-0.5 pl-0.5 pr-2">
        <Tooltip content={t('shell.statusBar.noteNavTooltip')} shortcut="panel.noteNavigation.toggle">
          <button
            type="button"
            onClick={onOpenTagPanel}
            className="h-full flex items-center gap-0.5 px-1.5 py-0 hover:bg-[var(--muted)]"
            aria-label={t('shell.statusBar.noteNav')}
          >
            <TagSvgIcon className="w-4 h-4" />
          </button>
        </Tooltip>
        <button
          type="button"
          className="h-full inline-flex items-center gap-0.5 px-1.5 text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
          aria-label={t('status.todos')}
          onClick={onOpenTodos}
        >
          <ListTodo className="w-3.5 h-3.5 shrink-0" />
        </button>
        <AgentConversationStatusBar />
        <div className="flex-1" />
        <ProductUpdatePill updater={updater} anchor={statusBarRightEdgeRef} />
        {charCount > 0 && (
          <span className="h-full inline-flex items-center gap-0.5 px-1.5 text-[var(--muted-foreground)] hover:bg-[var(--muted)]">
            {t('status.characters')}{' '}
            <span className="font-mono tabular-nums">{charCount}</span>
          </span>
        )}
        <PiRuntimeStatusIndicator />
        <Tooltip content={t('sync.panel.open')} side="top">
          <button
            type="button"
            onClick={() => useSyncPanelStore.getState().toggle()}
            className="h-full flex items-center justify-center px-1.5 py-0 text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
            aria-label={t('sync.panel.open')}
          >
            <ArrowsClockwiseIcon className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
        <Tooltip content={t('preferences.tabs.mcp')} side="top">
          <button
            type="button"
            onClick={onOpenMcpPreferences}
            className="h-full flex items-center justify-center px-1.5 py-0 hover:bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            aria-label={t('preferences.tabs.mcp')}
          >
            <span
              aria-hidden="true"
              className="h-3.5 w-3.5 shrink-0 bg-current"
              style={{
                mask: `url("${mcpPluginIcon}") center / contain no-repeat`,
                WebkitMask: `url("${mcpPluginIcon}") center / contain no-repeat`,
              } as CSSProperties}
            />
          </button>
        </Tooltip>
        <Tooltip content={t('shell.productIntro.button')} side="top">
          <button
            type="button"
            onClick={() => onProductIntroOpenChange(true)}
            className="h-full flex items-center justify-center px-1.5 py-0 text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
            aria-label={t('shell.productIntro.button')}
          >
            <Info className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </Tooltip>
      </div>
      <ProductIntroDialog open={productIntroOpen} onOpenChange={onProductIntroOpenChange} />
    </div>
  );
}
