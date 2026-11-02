import type { AgentConversationInstance } from '@features/agent/store/agent-conversation-types';
import type { NativeContextMenuItems } from '@platform/tauri/native-context-menu';
import type { NativeMenuIconImage } from '@platform/tauri/native-menu-icons';

export interface ConversationContextMenuLabels {
  openInBrowserColumn: string;
  favorite: string;
  unfavorite: string;
  rename: string;
  archive: string;
  delete: string;
}

export interface ConversationContextMenuActions {
  openInBrowserColumn: (instance: AgentConversationInstance) => void;
  toggleFavorite: (instanceId: string) => void;
  rename: (instance: AgentConversationInstance) => void;
  remove: (instance: AgentConversationInstance, action: 'archive' | 'delete') => void;
}

export function buildConversationContextMenuItems({
  instance,
  favorite,
  labels,
  icons,
  actions,
}: {
  instance: AgentConversationInstance;
  favorite: boolean;
  labels: ConversationContextMenuLabels;
  icons: {
    split: NativeMenuIconImage;
    star: NativeMenuIconImage;
    pencil: NativeMenuIconImage;
    archive: NativeMenuIconImage;
    delete: NativeMenuIconImage;
  };
  actions: ConversationContextMenuActions;
}): NativeContextMenuItems {
  return [
    {
      text: labels.openInBrowserColumn,
      icon: icons.split,
      action: () => actions.openInBrowserColumn(instance),
    },
    {
      text: favorite ? labels.unfavorite : labels.favorite,
      icon: icons.star,
      action: () => actions.toggleFavorite(instance.instanceId),
    },
    {
      text: labels.rename,
      icon: icons.pencil,
      action: () => actions.rename(instance),
    },
    { item: 'Separator' },
    {
      text: labels.archive,
      icon: icons.archive,
      action: () => actions.remove(instance, 'archive'),
    },
    {
      text: labels.delete,
      icon: icons.delete,
      action: () => actions.remove(instance, 'delete'),
    },
  ];
}
