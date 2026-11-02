import { describe, expect, it, vi } from 'vitest';
import type { AgentConversationInstance } from '@features/agent/store/agent-conversation-types';
import type { NativeMenuIconImage } from '@platform/tauri/native-menu-icons';
import { buildConversationContextMenuItems } from './conversation-context-menu';

const instance = { instanceId: 'conversation-1' } as AgentConversationInstance;

describe('conversation context menu builder', () => {
  it('keeps the native menu order and routes actions to the selected conversation', () => {
    const actions = {
      openInBrowserColumn: vi.fn(),
      toggleFavorite: vi.fn(),
      rename: vi.fn(),
      remove: vi.fn(),
    };
    const items = buildConversationContextMenuItems({
      instance,
      favorite: true,
      icons: {
        split: {} as NativeMenuIconImage,
        star: {} as NativeMenuIconImage,
        pencil: {} as NativeMenuIconImage,
        archive: {} as NativeMenuIconImage,
        delete: {} as NativeMenuIconImage,
      },
      labels: {
        openInBrowserColumn: 'Open',
        favorite: 'Favorite',
        unfavorite: 'Unfavorite',
        rename: 'Rename',
        archive: 'Archive',
        delete: 'Delete',
      },
      actions,
    });

    expect(items.map((item) => 'text' in item ? item.text : item.item)).toEqual([
      'Open',
      'Unfavorite',
      'Rename',
      'Separator',
      'Archive',
      'Delete',
    ]);

    if ('action' in items[0] && items[0].action) items[0].action('test');
    if ('action' in items[1] && items[1].action) items[1].action('test');
    if ('action' in items[4] && items[4].action) items[4].action('test');
    expect(actions.openInBrowserColumn).toHaveBeenCalledWith(instance);
    expect(actions.toggleFavorite).toHaveBeenCalledWith(instance.instanceId);
    expect(actions.remove).toHaveBeenCalledWith(instance, 'archive');
  });
});
