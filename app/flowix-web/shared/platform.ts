/**
 * 移动端 (Android/iOS) WebView 检测。
 *
 * Tauri mobile 的 WebView UA 携带平台标识, 桌面 WebView (Windows/macOS)
 * 不含这些词。用于引导屏等处按平台裁剪入口 (如移动端隐藏目录选择)。
 */
export function isMobileDevice(): boolean {
  return typeof navigator !== 'undefined' && /android|iphone|ipad|ipod/i.test(navigator.userAgent);
}

/**
 * True when the pointer cannot hover (touch-only). Hover-opened submenus must
 * skip their mouseenter open path there, or the synthetic hover that precedes
 * the first tap cancels the click's toggle and the menu needs two taps.
 */
export function supportsHover(): boolean {
  return typeof window !== 'undefined' && !(window.matchMedia?.('(hover: none), (pointer: coarse)')?.matches ?? false);
}
