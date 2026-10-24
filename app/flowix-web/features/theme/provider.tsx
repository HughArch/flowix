'use client';

import { useEffect } from 'react';
import { useAppTheme } from '@features/preferences/public/runtime-api';
import { applyTheme, sanitizeTheme } from '@/lib/theme';
import { windows } from '@platform/tauri/client';

/**
 * 全局主题应用层。
 *
 * 职责:
 * 1. 订阅 store 里的 settings.theme, 变化时调 applyTheme 写入 <html>。
 * 2. theme = 'system' 时订阅 prefers-color-scheme 变化, 实时跟随。
 * 3. 切换后 dispatch 'app-theme-changed' 事件 — 消费方 (markdown-editor) 借此
 *    强制 Shiki PM 插件重算装饰 (它只听文档变更, 不监听 CSS var)。
 *
 * 不在这里 dispatch 事件会让 markdown-editor 的 shiki 颜色停在旧主题。
 * 不订阅 mq 会让 'system' 模式不会响应系统切换。 都在 useEffect 里, 卸载时清理。
 */
/**
 * 把当前主题的 frame 底色同步给 Android 原生窗口。
 *
 * insets padding 露出的状态栏 / 手势条区域属于原生窗口背景, 不随网页 CSS
 * 变化 —— 深色主题下会残留一条白色。Kotlin 侧通过 addJavascriptInterface
 * 暴露 FlowixNative.setWindowBackground(hex); 非 Android 环境静默跳过。
 */
function syncNativeWindowBackground(): void {
  const bridge = (window as { FlowixNative?: { setWindowBackground?: (hex: string) => void } }).FlowixNative;
  if (!bridge?.setWindowBackground) {
    console.warn('[theme] FlowixNative bridge unavailable');
    return;
  }
  // 主题色可能是 oklch() 函数形式 (深色/自定义主题), 直接取数字当 RGB 会
  // 得到垃圾值。交给 Canvas 规范化: fillStyle 读回时一定是 #rrggbb / rgb()。
  const probe = document.createElement('span');
  probe.style.backgroundColor = 'var(--frame-bg)';
  probe.style.display = 'none';
  document.body.appendChild(probe);
  const declared = getComputedStyle(probe).backgroundColor;
  probe.remove();
  const canvas = document.createElement('canvas').getContext('2d');
  if (!canvas) return;
  canvas.fillStyle = declared;
  const normalized = String(canvas.fillStyle);
  let hex: string | null = null;
  if (/^#[0-9a-f]{6}$/i.test(normalized)) {
    hex = normalized;
  } else {
    const rgb = normalized.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
    if (rgb) {
      hex = `#${rgb.slice(1, 4)
        .map((value) => Number(value).toString(16).padStart(2, '0'))
        .join('')}`;
    }
  }
  if (!hex) return;
  bridge.setWindowBackground(hex);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = useAppTheme();

  useEffect(() => {
    const id = sanitizeTheme(theme);
    const root = document.documentElement;
    let active = true;
    // The IPC resolves after native UI work, so CSS reflects the actual backdrop.
    void windows.applyWindowTheme(id).then((material) => {
      if (!active) return;
      if (material === 'none') delete root.dataset.windowMaterial;
      else root.dataset.windowMaterial = material;
      try {
        if (material === 'none') localStorage.removeItem('flowix-window-material');
        else localStorage.setItem('flowix-window-material', material);
      } catch {
        // Storage is optional; the live native result remains authoritative.
      }
    }).catch((error) => {
      console.warn('Failed to apply native window theme', error);
    });
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const resolved = applyTheme(root, id, { prefersDark: mq.matches });
      syncNativeWindowBackground();
      window.dispatchEvent(new CustomEvent('app-theme-changed', { detail: { theme: resolved } }));
    };
    apply();
    const listener = () => apply();
    if (id === 'system') mq.addEventListener('change', listener);
    return () => {
      active = false;
      mq.removeEventListener('change', listener);
    };
  }, [theme]);

  return <>{children}</>;
}
