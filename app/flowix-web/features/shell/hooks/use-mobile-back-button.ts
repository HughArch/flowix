import { useEffect, useRef } from 'react';
import { isTauriRuntime } from '@shared/tauri-runtime';

export interface MobileBackButtonOptions {
  isMobile: boolean;
  /** 笔记导航抽屉是否展开。 */
  isDrawerOpen: boolean;
  /** 文档列是否占据整屏 (手机单栏)。 */
  isDocumentVisible: boolean;
  onCloseDrawer(): void;
  /** 从文档返回列表。 */
  onShowList(): void;
}

type BackInterceptor = () => boolean;

/**
 * 弹层返回键拦截器注册表 (后注册先响应)。
 * 历史版本弹窗、恢复确认弹窗等浮层在展开期间经 `useMobileBackInterceptor`
 * 挂入, 返回键优先关最上层的浮层, 而不是落到「返回列表 / 退出」。
 */
const backInterceptors: BackInterceptor[] = [];

/**
 * Android 返回键导航。
 *
 * 注册监听后 Tauri 不再执行默认行为 (webview history / 退出 Activity),
 * 因此必须自行处理: 抽屉 → 文档返回列表 → 退出应用。
 * 列表是导航根, 从列表返回即退出 (与常见笔记应用一致, 避免文档/列表往返)。
 * 仅在移动端且 Tauri 运行时绑定; 动态 import 避免影响桌面与测试环境。
 */
export function useMobileBackButton({
  isMobile,
  isDrawerOpen,
  isDocumentVisible,
  onCloseDrawer,
  onShowList,
}: MobileBackButtonOptions) {
  const stateRef = useRef({ isDrawerOpen, isDocumentVisible, onCloseDrawer, onShowList });
  stateRef.current = { isDrawerOpen, isDocumentVisible, onCloseDrawer, onShowList };

  useEffect(() => {
    if (!isMobile || !isTauriRuntime()) return;

    let disposed = false;
    let unlisten: (() => void) | undefined;
    const unregister = (listener: { unregister(): Promise<void> }) => {
      void listener.unregister().catch(() => {});
    };

    void import('@tauri-apps/api/app')
      .then(({ onBackButtonPress }) => onBackButtonPress(() => {
        const state = stateRef.current;
        for (let i = backInterceptors.length - 1; i >= 0; i -= 1) {
          if (backInterceptors[i]()) return;
        }
        if (state.isDrawerOpen) {
          state.onCloseDrawer();
          return;
        }
        if (state.isDocumentVisible) {
          state.onShowList();
          return;
        }
        void import('@tauri-apps/plugin-process')
          .then(({ exit }) => exit(0))
          .catch(() => {
            // 缺少 process:allow-exit 权限时保持前台, 不吞掉其他错误。
          });
      }))
      .then((listener) => {
        if (disposed) unregister(listener);
        else unlisten = () => unregister(listener);
      })
      .catch(() => {
        // 非移动端构建没有 app 插件事件通道。
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [isMobile]);
}

/**
 * 浮层挂载期间的返回键拦截: `active` 为 true 时入栈, 返回键从栈顶依次询问,
 * 返回 true 表示已消费 (通常 = 关闭该浮层)。供弹窗组件自行接入, 桌面无副作用。
 */
export function useMobileBackInterceptor(active: boolean, handler: () => boolean) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    if (!active) return;
    const interceptor = () => handlerRef.current();
    backInterceptors.push(interceptor);
    return () => {
      const index = backInterceptors.indexOf(interceptor);
      if (index >= 0) backInterceptors.splice(index, 1);
    };
  }, [active]);
}
