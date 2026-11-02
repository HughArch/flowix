import { invoke } from '@platform/tauri/core';
import type { ThemeId } from '@/lib/theme';

type WindowMaterial = 'none' | 'mica' | 'vibrancy';

// Each WebView has its own module instance and targets its own native window.
// Wait for native UI completion before submitting another theme, including
// across ThemeProvider remounts. Ignoring old responses alone cannot order
// the native side effects of concurrent async IPC commands.
let pendingTheme: Promise<void> = Promise.resolve();

export function applyWindowTheme(theme: ThemeId): Promise<WindowMaterial> {
  const result = pendingTheme.then(() =>
    invoke<WindowMaterial>('apply_window_theme', { theme }));
  // A failed request must reject its caller without blocking later themes.
  pendingTheme = result.then(() => undefined, () => undefined);
  return result;
}
