/** True only inside a Tauri desktop webview, not in a regular browser or test DOM. */
export function isTauriDesktopRuntime(): boolean {
  return typeof window !== 'undefined'
    && Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}
