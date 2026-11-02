import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * 移动端滚动收合容器: grid-rows 1fr ↔ 0fr 过渡支持任意子内容高度
 * (标题栏 / 状态栏高度不同, 无需逐个硬编码)。收合只改变编辑器视口
 * 高度, 宽度不变, 不会触发正文重新折行。
 */
export function MobileChromeCollapse({
  hidden,
  children,
}: {
  hidden: boolean;
  children: ReactNode;
}) {
  return (
    <div
      aria-hidden={hidden || undefined}
      inert={hidden || undefined}
      className={cn(
        'grid shrink-0',
        'transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none',
        hidden ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]',
      )}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}
