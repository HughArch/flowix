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
