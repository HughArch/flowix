'use client';

import { useCallback, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  FileTextIcon,
  LinkBreakIcon,
} from '@phosphor-icons/react';

import { useI18n } from '@/lib/i18n';
import { isWindowsPlatform } from '@features/shortcuts';
import { SidebarToggleIcon } from '@shared/icons/sidebar-toggle-icon';
import { Tooltip } from '@shared/ui/tooltip';
import {
  DOCUMENT_TITLEBAR_ICON_BUTTON_MAC,
  DOCUMENT_TITLEBAR_ICON_BUTTON_WIN,
} from '@features/document/components/document-titlebar-shared';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import { openNoteByNotebookPath, openNoteByPhysicalPath } from '@features/memo/public/note-navigation-api';
import { openWorkspaceSurface } from '@features/workspace/public/open-surface-api';
import { getAgentConversationPresentation } from '@features/agent/conversation-presentation';
import { toast } from '@/lib/toast';
import { WorkColumnTitlebarShell } from '@features/shell/components/work-column-titlebar-shell';
import { AgentConversationMoreMenu } from '@features/agent/components/agent-conversation-more-menu';
import { AgentConversationIdentity } from '@features/agent/components/agent-conversation-identity';

function AgentConversationHeader({ instanceId }: { instanceId: string }) {
  const { t } = useI18n();
  const isWindows = isWindowsPlatform();
  const instance = useAgentSessionStore((state) => state.getInstance(instanceId));
  const [renameRequest, setRenameRequest] = useState(0);
  const presentation = instance
    ? getAgentConversationPresentation(instance, t('common.untitled'))
    : null;

  const onOpenSourceDocument = useCallback(() => {
    if (!instance || !presentation?.hasSourceDocument) return;
    const { source } = presentation;
    const open = source?.notebookId && source.relativePath
      ? openNoteByNotebookPath(source.notebookId, source.relativePath)
      : source?.documentPath
        ? openNoteByPhysicalPath(source.documentPath).catch(() => openWorkspaceSurface({
          host: 'main-third',
          target: { kind: 'external', path: source.documentPath!, scopePath: null, transitionId: null },
        }).then(() => undefined))
        : Promise.resolve();
    void open.catch(() => toast.error(t('status.agent.originUnavailable')));
  }, [instance, presentation, t]);

  if (!instance || !presentation) return null;
  const actionButtonClass = isWindows
    ? DOCUMENT_TITLEBAR_ICON_BUTTON_WIN
    : DOCUMENT_TITLEBAR_ICON_BUTTON_MAC;

  return (
    <div className="relative flex h-full min-w-0 flex-1 items-center gap-2 pl-3">
      <AgentConversationIdentity
        instanceId={instance.instanceId}
        title={presentation.title}
        typeKey={instance.agentType}
        threadId={instance.threadId}
        sessionId={instance.providerSessionId}
        cwd={presentation.runtimeCwd}
        renameRequest={renameRequest}
        className="h-full flex-1 pl-0"
      />
      <div className={`ml-auto flex shrink-0 items-center ${isWindows ? 'gap-2 pr-3' : 'gap-3 pr-3'}`}>
        {presentation.hasSourceDocument ? (
          <button
            type="button"
            onClick={onOpenSourceDocument}
            aria-label={t('document.agent.viewInNote')}
            title={t('document.agent.viewInNote')}
            className={`${actionButtonClass} [-webkit-app-region:no-drag]`}
          >
            <FileTextIcon className="h-4 w-4" />
          </button>
        ) : (
          <span
            className="agent-thread-card__no-source"
            role="img"
            aria-label={t('document.agent.noSourceNote')}
            title={t('document.agent.noSourceNote')}
          >
            <LinkBreakIcon className="agent-thread-card__fullscreen-icon" aria-hidden="true" />
          </span>
        )}
        <AgentConversationMoreMenu
          instance={instance}
          iconButtonClass={actionButtonClass}
          onRename={() => setRenameRequest((request) => request + 1)}
        />
      </div>
    </div>
  );
}

export function AgentConversationTitlebar({
  reserveWindowsControls = true,
  instanceId,
  isMiddleColumnCollapsed,
  isSidebarVisible,
  onExpandSidebar,
  canNavigateBack,
  canNavigateForward,
  onNavigateBack,
  onNavigateForward,
}: {
  instanceId: string;
  reserveWindowsControls?: boolean;
  isMiddleColumnCollapsed: boolean;
  isSidebarVisible: boolean;
  onExpandSidebar: () => void;
  canNavigateBack: boolean;
  canNavigateForward: boolean;
  onNavigateBack: () => void;
  onNavigateForward: () => void;
}) {
  const { t } = useI18n();
  const isWindows = isWindowsPlatform();

  const navigationButtonClass =
    'flex h-8 w-8 items-center justify-center rounded-lg text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-35';

  return (
    <WorkColumnTitlebarShell
      isWindows={isWindows}
      reserveWindowsControls={reserveWindowsControls}
      showTrafficLightSpacer={isMiddleColumnCollapsed && !isSidebarVisible}
      className="agent-conversation-titlebar"
    >
      <div className="flex shrink-0 items-center gap-1">
        {isMiddleColumnCollapsed && (
          <>
            <button
              type="button"
              onClick={onExpandSidebar}
              aria-label={t('document.titlebar.showSidebar')}
              title={t('document.titlebar.showSidebarTooltip')}
              className={`flex h-5 w-5 shrink-0 items-center justify-center text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)] [-webkit-app-region:no-drag] ${
                isWindows ? 'rounded-lg' : 'rounded-xl'
              }`}
            >
              <SidebarToggleIcon
                className={isWindows ? 'h-4 w-4' : 'h-5 w-5'}
                variant="collapsed"
              />
            </button>
          </>
        )}
        <Tooltip content={t('document.titlebar.backTooltip')} shortcut="history.back">
          <button
            type="button"
            onClick={onNavigateBack}
            disabled={!canNavigateBack}
            aria-label={t('document.titlebar.back')}
            className={`${navigationButtonClass} [-webkit-app-region:no-drag]`}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        </Tooltip>
        <Tooltip content={t('document.titlebar.forwardTooltip')} shortcut="history.forward">
          <button
            type="button"
            onClick={onNavigateForward}
            disabled={!canNavigateForward}
            aria-label={t('document.titlebar.forward')}
            className={`${navigationButtonClass} [-webkit-app-region:no-drag]`}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </Tooltip>
      </div>
      <div data-tauri-drag-region className="min-w-0 flex-1 self-stretch">
        <AgentConversationHeader instanceId={instanceId} />
      </div>
    </WorkColumnTitlebarShell>
  );
}
