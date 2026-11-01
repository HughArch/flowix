'use client';

import { type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';

import type { Notebook } from '@features/memo/store/note-store';
import { MemoListTitlebarMac } from '@features/memo/components/memo-list-titlebar-mac';
import { MemoListTitlebarWin } from '@features/memo/components/memo-list-titlebar-win';
import { cn } from '@/lib/utils';

interface ListColumnProps {
  hidden: boolean;
  memoColWidth: number;
  /**
   * 手机单栏: 列表脱离文档流, 变成绝对定位的整屏抽屉, transform 滑入/滑出
   * (文档列保持挂载在下层), 忽略拖拽保存的列宽。
   */
  mobileFullWidth?: boolean;
  /** 手机单栏覆盖层模式: 外层挂手势监听用。 */
  containerRef?: RefObject<HTMLDivElement | null>;
  isDraggingListDivider: boolean;
  selectedNotebook: Notebook | null;
  onCollapseMemoList: () => void;
  onOpenPreferences: (tab?: string) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  children: ReactNode;
}

function ListColumnTitlebar({
  selectedNotebook,
  onCollapseMemoList,
  onOpenPreferences,
}: Pick<
  ListColumnProps,
  | 'selectedNotebook'
  | 'onCollapseMemoList'
  | 'onOpenPreferences'
>) {
  const props = {
    selectedNotebook,
    onCollapseMemoList,
    onOpenPreferences,
  };

  // Android WebView 的 UA/platform 不含 Win, 会误选 Mac 变体 (预留苹果
  // 状态区, 图标顶到中间); 移动端与 Windows 一样使用 Win 变体。
  return /Windows|Android/i.test(navigator.userAgent) || /Win/i.test(navigator.platform)
    ? <MemoListTitlebarWin {...props} />
    : <MemoListTitlebarMac {...props} />;
}

export function ListColumn({
  hidden,
  memoColWidth,
  mobileFullWidth = false,
  containerRef,
  isDraggingListDivider,
  selectedNotebook,
  onCollapseMemoList,
  onOpenPreferences,
  onPointerDown,
  children,
}: ListColumnProps) {
  return (
    <div
      ref={containerRef}
      className={cn(
        'relative flex h-full flex-col',
        mobileFullWidth
          ? // 手机抽屉: 绝对定位整屏滑入/滑出。transform 走合成器动画,
            // 不触发任何重排; 文档列保持挂载在被覆盖的下层。
            cn(
              'absolute inset-y-0 left-0 z-[80] w-full will-change-[transform]',
              'shadow-[12px_0_28px_-12px_rgb(0_0_0_/_0.28)]',
              'transition-transform duration-[260ms] ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none',
              hidden ? '-translate-x-full' : 'translate-x-0',
            )
          : cn(
              'shrink-0 will-change-[width]',
              isDraggingListDivider
                ? 'transition-none'
                : 'transition-[width] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none',
              'overflow-hidden',
            ),
      )}
      style={mobileFullWidth ? undefined : { width: hidden ? 0 : memoColWidth }}
      aria-hidden={hidden}
      inert={mobileFullWidth && hidden ? true : undefined}
      onPointerDown={onPointerDown}
    >
      <div
        className={mobileFullWidth
          ? // 抽屉整体滑动, 内容保持不透明 (淡出只服务于停靠模式的宽度裁切)。
            'relative h-full w-full overflow-hidden bg-[var(--list-bg)]'
          : cn(
              'relative h-full overflow-hidden bg-[var(--list-bg)]',
              // 收起/展开期间内容淡出淡入, 配合外层宽度过渡, 避免
              // 列表被生硬裁切; 内容宽度固定, 宽度动画不再逐帧重排。
              'transition-opacity duration-150 motion-reduce:transition-none',
              hidden ? 'opacity-0' : 'opacity-100',
            )}
        style={mobileFullWidth ? undefined : { width: memoColWidth }}
      >
        <ListColumnTitlebar
          selectedNotebook={selectedNotebook}
          onCollapseMemoList={onCollapseMemoList}
          onOpenPreferences={onOpenPreferences}
        />
        <div className="relative min-h-0 flex-1">
          {children}
        </div>
      </div>
    </div>
  );
}
