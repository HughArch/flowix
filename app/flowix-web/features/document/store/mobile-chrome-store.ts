import { create } from 'zustand';
import { isMobileDevice } from '@shared/platform';

interface MobileChromeState {
  /** 上滑浏览文档内容时收起标题栏 / 状态栏 (仅移动端布局消费)。 */
  hidden: boolean;
  setHidden: (hidden: boolean) => void;
}

export const useMobileChromeStore = create<MobileChromeState>((set) => ({
  hidden: false,
  setHidden: (hidden) => set((state) => (state.hidden === hidden ? state : { hidden })),
}));

/** 连续上滑浏览该距离后收起 chrome。 */
const HIDE_THRESHOLD_PX = 56;
/** 反向下滑该距离后恢复显示 (滞后阈值, 避免边界处来回抖动)。 */
const SHOW_THRESHOLD_PX = 40;
/** 顶部附近始终显示, 避免刚打开文档就收走标题栏。 */
const KEEP_VISIBLE_NEAR_TOP_PX = 64;
/** 单次滚动位移超过该值视为程序化跳转 (换文档 / 锚点定位), 丢弃方向累积。 */
const JUMP_RESET_PX = 400;

export type MobileChromeScrollTracker = (scrollTop: number) => void;

/**
 * 编辑器滚动方向 → chrome 显隐意图。
 *
 * 单个累加器记录未决位移: 正值 = 上滑浏览 (收起), 负值 = 下滑回看 (恢复)。
 * 反向滚动先抵消反向累积, 天然形成滞后; 触发翻转后清零, 两个方向的阈值
 * 彼此独立。桌面端 no-op ── 滚动条常驻, 收走 chrome 只会添乱。
 *
 * 追踪器实例与 DocumentContainer 同生命周期; 编辑器滚动容器随文档重建时,
 * 位置跳变由 JUMP_RESET_PX 兜底。
 */
export function createMobileChromeScrollTracker(): MobileChromeScrollTracker {
  let lastTop = 0;
  let accumulated = 0;
  let observed = false;

  return (scrollTop) => {
    if (!isMobileDevice()) return;
    if (!observed) {
      observed = true;
      lastTop = scrollTop;
      return;
    }
    const delta = scrollTop - lastTop;
    lastTop = scrollTop;
    if (Math.abs(delta) > JUMP_RESET_PX) {
      accumulated = 0;
      return;
    }
    if (scrollTop <= KEEP_VISIBLE_NEAR_TOP_PX) {
      accumulated = 0;
      useMobileChromeStore.getState().setHidden(false);
      return;
    }
    accumulated = delta > 0
      ? Math.min(accumulated + delta, HIDE_THRESHOLD_PX)
      : Math.max(accumulated + delta, -SHOW_THRESHOLD_PX);
    const { hidden, setHidden } = useMobileChromeStore.getState();
    if (!hidden && accumulated >= HIDE_THRESHOLD_PX) {
      setHidden(true);
      accumulated = 0;
    } else if (hidden && accumulated <= -SHOW_THRESHOLD_PX) {
      setHidden(false);
      accumulated = 0;
    }
  };
}
