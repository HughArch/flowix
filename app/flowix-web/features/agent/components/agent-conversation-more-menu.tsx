'use client';

import { useEffect, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import {
  ArchiveIcon,
  PencilSimpleIcon,
  SquareSplitHorizontalIcon,
  StarIcon,
  TrashSimpleIcon,
} from '@phosphor-icons/react';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import type { AgentConversationInstance } from '@features/agent/store/agent-conversation-types';
import { AgentMessageFontSwitcher, useAgentMessageFontSwitch } from '@features/agent/components/agent-message-font-switcher';
import {
  isFavoriteConversation,
  subscribeToFavoriteConversationChanges,
  toggleFavoriteConversation,
} from '@features/agent/conversation-favorites';
import { openBrowserColumnAgentConversation } from '@features/workspace/use-cases/browser-column-navigation';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@shared/ui/dropdown-menu';

const itemClass = 'group h-7 items-center justify-start gap-2 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]';

/** Shared Agent conversation actions used by both dedicated and fullscreen embedded conversations. */
export function AgentConversationMoreMenu({
  instance,
  iconButtonClass,
  onRename,
}: {
  instance: AgentConversationInstance;
  iconButtonClass: string;
  onRename: () => void;
}) {
  const { t } = useI18n();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('document.agent.moreActions')}
          title={t('document.agent.moreActions')}
          className={`${iconButtonClass} [-webkit-app-region:no-drag]`}
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[202px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
        <AgentConversationMoreMenuItems instance={instance} onRename={onRename} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AgentConversationMoreMenuItems({
  instance,
  onRename,
}: {
  instance: AgentConversationInstance;
  onRename: () => void;
}) {
  const { t } = useI18n();
  const fontSwitch = useAgentMessageFontSwitch();
  const [isFavorite, setIsFavorite] = useState(() => isFavoriteConversation(instance.instanceId));

  useEffect(() => {
    setIsFavorite(isFavoriteConversation(instance.instanceId));
    return subscribeToFavoriteConversationChanges(() => {
      setIsFavorite(isFavoriteConversation(instance.instanceId));
    });
  }, [instance.instanceId]);

  const removeConversation = async (action: 'archive' | 'delete') => {
    if (action === 'delete' && !window.confirm(t('agent.chat.conversation.deleteConfirm'))) return;
    try {
      const session = useAgentSessionStore.getState();
      if (instance.threadId) {
        await (action === 'archive'
          ? session.archiveThread(instance.threadId)
          : session.deleteThread(instance.threadId));
      } else {
        session.removeInstance(instance.instanceId);
      }
      toast.success(t(action === 'archive' ? 'status.agent.archiveSuccess' : 'status.agent.deleteSuccess'));
    } catch (error) {
      toast.error(error instanceof Error
        ? error.message
        : t(action === 'archive' ? 'status.agent.archiveFailed' : 'status.agent.deleteFailed'));
    }
  };

  return (
    <>
      <AgentMessageFontSwitcher
        fontMode={fontSwitch.fontMode}
        sizeMode={fontSwitch.sizeMode}
        downloadingMode={fontSwitch.downloadingMode}
        percent={fontSwitch.percent}
        onSelect={fontSwitch.selectFontMode}
      />
      <DropdownMenuItem
        onClick={() => void openBrowserColumnAgentConversation(instance.instanceId).catch((error) =>
          toast.error(error instanceof Error ? error.message : String(error)))}
        className={itemClass}
      >
        <SquareSplitHorizontalIcon className="h-4 w-4" /> {t('workColumn.context.openInBrowserColumn')}
      </DropdownMenuItem>
      <DropdownMenuItem
        onClick={() => setIsFavorite(toggleFavoriteConversation(instance.instanceId).has(instance.instanceId))}
        className={itemClass}
      >
        <StarIcon className="h-4 w-4" weight={isFavorite ? 'fill' : 'regular'} />
        {isFavorite ? t('agent.chat.conversation.unfavorite') : t('agent.chat.conversation.favorite')}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={onRename} className={itemClass}>
        <PencilSimpleIcon className="h-4 w-4" /> {t('agent.chat.conversation.rename')}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => void removeConversation('archive')} className={itemClass}>
        <ArchiveIcon className="h-4 w-4" /> {t('document.agent.archiveConversation')}
      </DropdownMenuItem>
      <DropdownMenuItem
        onClick={() => void removeConversation('delete')}
        className="group h-7 items-center gap-2 rounded-lg px-2 py-0 hover:bg-transparent hover:text-[var(--destructive)]"
      >
        <TrashSimpleIcon className="h-4 w-4" /> {t('document.agent.deleteConversation')}
      </DropdownMenuItem>
    </>
  );
}
