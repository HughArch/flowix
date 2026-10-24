import { useEffect, useRef, type RefObject } from 'react';

export interface MobileSwipeGestureOptions {
  enabled: boolean;
  /** 手势监听区域: 文档内容列。 */
  targetRef: RefObject<HTMLElement | null>;
  onSwipeDown(): void;
  onSwipeRight(): void;
  onSwipeLeft(): void;
}

/** 水平手势最小位移 (px)。 */
const HORIZONTAL_THRESHOLD = 56;
/** 垂直手势最小位移 (px)。 */
const VERTICAL_THRESHOLD = 80;
/** 主方向必须明显压过另一个轴, 避免斜向滚动误判。 */
const AXIS_RATIO = 1.6;
/** 超过该时长视为慢速拖拽 (滚动/选择), 不触发挥手。 */
const MAX_GESTURE_MS = 700;

function findScrollableAncestor(start: Element | null): HTMLElement | null {
  let node = start instanceof HTMLElement ? start : null;
  while (node) {
    if (node.scrollHeight > node.clientHeight + 1) return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * 文档内容区的触屏手势:
 * - 下滑 (内容已在顶部): 搜索面板
 * - 右滑: 左侧列表面板
 * - 左滑: 目录 (outline)
 *
 * 使用 Touch Events 而不是 Pointer Events: 触摸滚动开始时 WebView 会向
 * 页面派发 pointercancel, 水平拖动会被当成滚动手势中断, pointermove
 * 拿不到完整位移。touchmove 不受该取消影响。
 * 监听为 passive, 不阻止原生滚动/选择。
 */
export function useMobileSwipeGestures({
  enabled,
  targetRef,
  onSwipeDown,
  onSwipeRight,
  onSwipeLeft,
}: MobileSwipeGestureOptions) {
  const callbacksRef = useRef({ onSwipeDown, onSwipeRight, onSwipeLeft });
  callbacksRef.current = { onSwipeDown, onSwipeRight, onSwipeLeft };

  useEffect(() => {
    if (!enabled) return;
    const target = targetRef.current;
    if (!target) return;

    let tracking = false;
    let startX = 0;
    let startY = 0;
    let startedAt = 0;
    let atTop = false;
    let consumed = false;

    const reset = () => {
      tracking = false;
      consumed = false;
    };

    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1 || tracking) return;
      const touch = event.touches[0];
      tracking = true;
      consumed = false;
      startX = touch.clientX;
      startY = touch.clientY;
      startedAt = Date.now();
      const scroller = findScrollableAncestor(event.target as Element | null);
      atTop = !scroller || scroller.scrollTop <= 0;
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (!tracking || consumed || event.touches.length !== 1) return;
      if (Date.now() - startedAt > MAX_GESTURE_MS) {
        reset();
        return;
      }
      const touch = event.touches[0];
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      const absX = Math.abs(dx);
      const absY = Math.abs(dy);

      if (absX >= HORIZONTAL_THRESHOLD && absX > absY * AXIS_RATIO) {
        consumed = true;
        if (dx > 0) callbacksRef.current.onSwipeRight();
        else callbacksRef.current.onSwipeLeft();
        return;
      }

      // 下滑只在内容已滚到顶部时成立, 否则那是正常的往回滚动。
      if (atTop && dy >= VERTICAL_THRESHOLD && absY > absX * AXIS_RATIO) {
        consumed = true;
        callbacksRef.current.onSwipeDown();
      }
    };

    target.addEventListener('touchstart', handleTouchStart, { passive: true });
    target.addEventListener('touchmove', handleTouchMove, { passive: true });
    target.addEventListener('touchend', reset, { passive: true });
    target.addEventListener('touchcancel', reset, { passive: true });
    return () => {
      target.removeEventListener('touchstart', handleTouchStart);
      target.removeEventListener('touchmove', handleTouchMove);
      target.removeEventListener('touchend', reset);
      target.removeEventListener('touchcancel', reset);
    };
  }, [enabled, targetRef]);
}
