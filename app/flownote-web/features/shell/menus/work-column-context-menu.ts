import type { NativeContextMenuItems } from '@platform/tauri/native-context-menu';

export function buildWorkColumnContextMenuItems({
  label,
  enabled,
  openInBrowserColumn,
}: {
  label: string;
  enabled: boolean;
  openInBrowserColumn: () => void;
}): NativeContextMenuItems {
  return [{
    text: label,
    enabled,
    action: () => {
      if (enabled) openInBrowserColumn();
    },
  }];
}
