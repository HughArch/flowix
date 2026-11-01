import { create } from 'zustand'

/**
 * 移动端右侧抽屉 (Obsidian 式面板) 的开关状态。
 *
 * 开关按钮在文档标题栏 (features/document), 抽屉本体挂在编辑器
 * (features/editor, 需要.editor 实例渲染目录) —— 两端用这个共享 store
 * 解耦, 不做跨组件 props 钻孔。
 */

export type MobileRightDrawerTab = 'outline'

interface MobileRightDrawerState {
  isOpen: boolean
  tab: MobileRightDrawerTab
  /** 未传 tab 时保持当前页, 只做开 ↔ 关。 */
  toggle: (tab?: MobileRightDrawerTab) => void
  close: () => void
}

export const useMobileRightDrawerStore = create<MobileRightDrawerState>((set) => ({
  isOpen: false,
  tab: 'outline',
  toggle: (tab) => set((state) => ({ isOpen: !state.isOpen, tab: tab ?? state.tab })),
  close: () => set({ isOpen: false }),
}))
