import type { MenuOptions } from '@tauri-apps/api/menu';
import type { SubmenuOptions } from '@tauri-apps/api/menu/submenu';
import { createLogger } from '@/lib/logger';
import { isMac } from '@/lib/shortcuts/platform';
import { isTauriDesktopRuntime } from './runtime';

const logger = createLogger('native-context-menu');

export type NativeContextMenuItems = NonNullable<MenuOptions['items']>;
type NativeContextMenuItem = NativeContextMenuItems[number];
type InlineNativeSubmenu = SubmenuOptions & { items: NativeContextMenuItems };
export interface NativeContextMenuPosition {
  x: number;
  y: number;
}

/**
 * Approximate logical widths of native menus anchored manually.
 * Tauri/macOS does not expose an NSMenu's size before it is shown, so these
 * values are kept as one central calibration point.
 */
export const NATIVE_MENU_WIDTHS = {
  conversation: 120,
  documentActions: 192,
} as const;

/** Shared vertical gap between the trigger and manually anchored menus. */
export const NATIVE_MENU_DEFAULT_GAP = 12;

export type NativeMenuWidthPreset = keyof typeof NATIVE_MENU_WIDTHS;

export function nativeMenuWidth(preset: NativeMenuWidthPreset): number {
  return NATIVE_MENU_WIDTHS[preset];
}

export function canUseNativeContextMenu(): boolean {
  return isMac() && isTauriDesktopRuntime();
}

/** Keep native-menu failures on one structured logging path. */
export function logNativeContextMenuError(scope: string, error: unknown): void {
  logger.warn(`failed to open ${scope} menu`, { error: String(error) });
}

function isInlineNativeSubmenu(item: NativeContextMenuItem): item is InlineNativeSubmenu {
  return typeof item === 'object'
    && item !== null
    && 'text' in item
    && typeof item.text === 'string'
    && 'items' in item
    && Array.isArray(item.items);
}

/**
 * Tauri's JS menu payload is an untagged union. An inline submenu that also
 * has an icon can otherwise be decoded as an IconMenuItem before it reaches
 * the Submenu variant, which silently drops its `items` on macOS. Materialize
 * every inline submenu as a Submenu resource before creating the root menu.
 */
async function materializeNativeSubmenus(
  items: NativeContextMenuItems,
  createSubmenu: (options: InlineNativeSubmenu) => Promise<NativeContextMenuItem>,
): Promise<NativeContextMenuItems> {
  const materialized: NativeContextMenuItems = [];
  for (const item of items) {
    if (!isInlineNativeSubmenu(item)) {
      materialized.push(item);
      continue;
    }

    const children = await materializeNativeSubmenus(item.items, createSubmenu);
    materialized.push(await createSubmenu({ ...item, items: children }));
  }
  return materialized;
}

export async function popupNativeContextMenu(
  event: { preventDefault(): void; stopPropagation(): void },
  items: NativeContextMenuItems,
  position?: NativeContextMenuPosition,
): Promise<boolean> {
  if (!canUseNativeContextMenu()) return false;
  event.preventDefault();
  event.stopPropagation();
  const { Menu, Submenu } = await import('@tauri-apps/api/menu');
  const materializedItems = await materializeNativeSubmenus(
    items,
    (options) => Submenu.new(options),
  );
  const menu = await Menu.new({ items: materializedItems });
  if (position) {
    const { LogicalPosition } = await import('@tauri-apps/api/dpi');
    await menu.popup(new LogicalPosition(position.x, position.y));
  } else {
    await menu.popup();
  }
  return true;
}

/** Position a native popup below an element with an estimated right-edge alignment. */
export function nativeMenuPositionBelowEnd(
  element: Element,
  estimatedMenuWidth: number,
  gap = NATIVE_MENU_DEFAULT_GAP,
): NativeContextMenuPosition {
  const rect = element.getBoundingClientRect();
  return {
    x: Math.max(4, rect.right - estimatedMenuWidth),
    y: rect.bottom + gap,
  };
}
