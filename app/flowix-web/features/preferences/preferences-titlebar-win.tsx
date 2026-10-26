'use client';

import { ArrowLeft } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { isMobileDevice } from '@shared/platform';

/** 移动端: 设置在窗口内以 #preferences 路由呈现, 用返回按钮回到主界面。 */
function closePreferences() {
  window.location.hash = '';
}

/**
 * Windows title bar for the Preferences window.
 *
 * Design rules:
 * - 通栏 (spans the full window width above both sidebar and content)
 * - 高度与控制条一致 (h-9 / 36px, identical to the standard Windows control bar)
 * - 左侧展示标题 Preferences
 * - 右侧预留 126px (= 42 + 42 + 42) 给 <WindowsTitlebarControls />
 *   渲染的最小化/最大化/关闭按钮
 * - 整条都作为 Tauri drag region
 */
interface PreferencesTitlebarWinProps {
  /** 移动端返回按钮的回调; 未传时保持退出设置 (回主界面) 的默认行为。 */
  onBack?: () => void;
}

export function PreferencesTitlebarWin({ onBack }: PreferencesTitlebarWinProps) {
  const { t } = useI18n();
  const title = t('preferences.title');

  return (
    <div
      data-tauri-drag-region
      className="h-9 shrink-0 pl-4 pr-[126px] flex items-center gap-2 bg-[var(--bg-titlebar)] border-b border-solid border-[var(--divider)] select-none"
    >
      {isMobileDevice() && (
        <button
          type="button"
          onClick={onBack ?? closePreferences}
          aria-label={t('common.back')}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
      <span
        className="text-sm font-semibold tracking-tight text-[var(--foreground)] pointer-events-none"
        aria-label={title}
      >
        {title}
      </span>
    </div>
  );
}
