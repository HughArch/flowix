import { useEffect, useRef, useState, type RefObject } from 'react';

export interface MobileSwipeGestureOptions {
  enabled: boolean;
  /**
   * 输入面板 (软键盘) 弹起时为 true ── 手势整体禁用, 编辑行为 (文本选择、
   * 放大镜) 完全交回原生。键盘收起后手势恢复。
   */
  disabled?: boolean;
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
/** 水平位移达到该值即接管手势 (preventDefault), 赶在文本选择/放大镜启动之前。 */
const INTERCEPT_THRESHOLD = 14;

function findScrollableAncestor(start: Element | null): HTMLElement | null {
  let node = start instanceof HTMLElement ? start : null;
  while (node) {
    if (node.scrollHeight > node.clientHeight + 1) return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * 软键盘可见性检测。
 *
 * IME inset 已在原生层做了 content padding, 因此键盘弹出表现为
 * window.innerHeight 收缩; 以观测到的最大高度为基准, 收缩超过阈值即视为
 * 键盘可见 (旋转等整屏 resize 会抬高基准, 不会误判)。
 */
export function useImeVisible(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let baseline = window.innerHeight;
    const update = () => {
      const height = window.innerHeight;
      if (height > baseline) baseline = height;
      setVisible(baseline - height > 150);
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return visible;
}

/**
 * 文档内容区的触屏手势:
 * - 下滑 (内容已在顶部): 搜索面板
 * - 右滑: 左侧列表面板
 * - 左滑: 目录 (outline)
 *
 * touchmove 必须注册为非 passive: 横向滑动手势需要 preventDefault,
 * 否则 contenteditable 会把它当成文本选择拖拽, 弹出系统放大镜。
 * 纵向不拦截, 正文滚动与文本选择交给原生。
 */
export function useMobileSwipeGestures({
  enabled,
  disabled = false,
  targetRef,
  onSwipeDown,
  onSwipeRight,
  onSwipeLeft,
}: MobileSwipeGestureOptions) {
  const callbacksRef = useRef({ onSwipeDown, onSwipeRight, onSwipeLeft });
  callbacksRef.current = { onSwipeDown, onSwipeRight, onSwipeLeft };

  useEffect(() => {
    if (!enabled || disabled) return;
    const target = targetRef.current;
    if (!target) return;

    let tracking = false;
    let intercepting = false;
    let startX = 0;
    let startY = 0;
    let startedAt = 0;
    let atTop = false;
    let consumed = false;

    const reset = () => {
      tracking = false;
      intercepting = false;
      consumed = false;
    };

    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1 || tracking) return;
      const touch = event.touches[0];
      tracking = true;
      intercepting = false;
      consumed = false;
      startX = touch.clientX;
      startY = touch.clientY;
      startedAt = Date.now();
      const scroller = findScrollableAncestor(event.target as Element | null);
      atTop = !scroller || scroller.scrollTop <= 0;
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (!tracking || event.touches.length !== 1) return;
      const touch = event.touches[0];
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      const absX = Math.abs(dx);
      const absY = Math.abs(dy);

      // 横向意图成型即接管: 阻止 WebView 启动文本选择/放大镜。
      if (!intercepting && !consumed && absX > INTERCEPT_THRESHOLD && absX > absY) {
        intercepting = true;
      }
      if (intercepting) event.preventDefault();

      if (consumed || Date.now() - startedAt > MAX_GESTURE_MS) return;

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

    const handleTouchEnd = () => reset();

    target.addEventListener('touchstart', handleTouchStart, { passive: true });
    target.addEventListener('touchmove', handleTouchMove, { passive: false });
    target.addEventListener('touchend', handleTouchEnd, { passive: true });
    target.addEventListener('touchcancel', handleTouchEnd, { passive: true });
    return () => {
      target.removeEventListener('touchstart', handleTouchStart);
      target.removeEventListener('touchmove', handleTouchMove);
      target.removeEventListener('touchend', handleTouchEnd);
      target.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [enabled, disabled, targetRef]);
}
