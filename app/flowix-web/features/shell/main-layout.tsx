'use client';

import { ColumnResizeHandle } from './components/column-resize-handle';
import { focusWorkspaceHostFromEvent } from '@features/workspace/public/host-api';

import { createLogger } from '@/lib/logger';
import { canonicalPath, canonicalDirectoryPath, notebookRelativeDirectoryPath, parentDirectoryPath } from '@/lib/path';
import {
  setMemoListViewPreference,
  useMemoListViewPreference,
} from '@features/preferences/public/runtime-api';
const logger = createLogger('main-layout');

import { lazy, Suspense, useState, useEffect, useRef, useCallback } from 'react';
import {
  DocumentTitlebarWin,
  resolveDocumentTitlebarTarget,
  DocumentTitlebarMac,
  navigateDocumentHistory,
  useDocumentCommands,
  useShellDocumentHistory,
  useShellDocumentViewModel,
  captureLatestDocumentContent,
  setDocumentEditorMode,
  useDocumentEditorMode,
  type DocumentEditorMode,
  type DocumentHistoryEntry,
} from '@features/document/public/shell-api';
import {
  MemoList,
  MemoListServicesHost,
  NoteNavigationDrawer,
  useShellMemoViewModel,
  type Notebook,
} from '@features/memo/public/shell-api';
import { AgentConversationTitlebar } from '@features/agent/public/shell-api';
import { SyncStatusPanel } from '@features/sync-status';
import { MobileAgentPanel } from '@features/agent/components/mobile-agent-panel';
import { useSettingsStore } from '@/lib/store/settings-store';
import { useWorkspaceStartupStore, isWorkspaceInteractive } from '@/lib/store/workspace-startup-store';
import { useShallow } from 'zustand/react/shallow';
import {
  product,
  windows,
  boot,
} from '@platform/tauri/client';
import { files } from '@platform/tauri/client/desktop';
import { subscribe } from '@platform/tauri/event-bus';
import { WindowsTitlebarControls } from '@shared/window-titlebar-controls';
import { NotebookDeleteDialog } from '@features/shell/components/notebook-delete-dialog';
import { ExternalFileDropOverlay } from '@features/shell/components/drag-overlay/external-file-drop-overlay';
import { useMainMiddleColumnController } from '@features/shell/hooks/use-main-middle-column-controller';
import { useMainPanelController } from '@features/shell/hooks/use-main-panel-controller';
import { useIsMobileViewport } from '@features/shell/hooks/use-is-mobile-viewport';
import { useMobileBackButton } from '@features/shell/hooks/use-mobile-back-button';
import { useMobileSwipeGestures, useImeVisible } from '@features/shell/hooks/use-mobile-swipe-gestures';
import { isMobileDevice } from '@shared/platform';
import { ListColumn } from '@features/shell/components/list-column';
import { ListColumnContent } from '@features/shell/components/list-column-content';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { openPath } from '@platform/tauri/opener';
import { Button } from '@shared/ui/button';
import type { AppUpdaterState } from '@features/shell/hooks/use-app-updater';
import {
  WorkColumnContentHost,
  resolveWorkColumnRuntimePresentation,
  resolveWorkColumnPresentation,
  useWorkspaceSurfacePresentation,
  type DocumentSurfaceContext,
} from '@features/surface/public/shell-api';
import type { PluginDescriptor } from '@platform/tauri/client';
import {
  useShellWorkspaceViewModel,
  BROWSER_COLUMN_MIN_WIDTH,
  clearBrowserColumnExternalPath,
  type WorkColumnTarget,
} from '@features/workspace/public/shell-api';
import { MainStatusBarHost } from '@features/shell/components/main-status-bar-host';
import { CenteredLoadingSpinner } from '@shared/ui/centered-loading-spinner';
import type { Editor } from '@tiptap/core';
import { OnboardingScreen } from '@features/onboarding';
import { finishOnboardingNotebook } from '@features/shell/use-cases/finish-onboarding';
import { documentHistoryEntryKey } from '@features/document/public/shell-api';
import { clearWorkspaceTargetForDeletedFile, deleteMainExternalDocument, historyEntryFromWorkColumnTarget } from '@features/workspace/public/shell-api';

const DOCUMENT_PANEL_MIN_WIDTH = BROWSER_COLUMN_MIN_WIDTH;
const PRODUCT_INTRO_AUTO_SHOWN_KEY = 'flowix:product-intro:auto-shown';


const BrowserColumn = lazy(() =>
  import('@features/shell/components/browser-column').then((module) => ({
    default: module.BrowserColumn,
  })),
);

function isWindowsPlatform(): boolean {
  return /Windows/i.test(navigator.userAgent) || /Win/i.test(navigator.platform);
}


function isDifferentHistoryTarget(
  entry: DocumentHistoryEntry,
  currentWorkColumnTarget: WorkColumnTarget,
): boolean {
  return documentHistoryEntryKey(entry)
    !== documentHistoryEntryKey(historyEntryFromWorkColumnTarget(currentWorkColumnTarget));
}

export interface MainLayoutBusinessController {
  notebookToDelete: Notebook | null;
  notebookCreateRequest: number;
  cancelDeleteNotebook(): void;
  confirmDeleteNotebook(deleteLocalFiles: boolean): Promise<void>;
  createNotebook(): void;
  deleteNotebook(notebook: Notebook): void;
  editNotebook(notebook: Notebook): void;
  openPlugin(plugin: PluginDescriptor): Promise<void>;
  switchFolderCollectionType(target: {
    filePath: string;
    notebookPath: string;
    notebookId: string;
  }, type: 'table' | 'media_library'): Promise<void>;
  selectNotebook(notebook: Notebook): void;
}

export interface MainLayoutSystemController {
  onboardingOpen: boolean;
  onboardingLoading: boolean;
  updater: AppUpdaterState;
  hasPendingAppUpdateResult: boolean;
  presentPendingAppUpdateResult(): void;
  completeOnboarding(): Promise<void>;
}

export function MainLayout({
  business,
  system,
}: {
  business: MainLayoutBusinessController;
  system: MainLayoutSystemController;
}) {
  const { t } = useI18n();
  const [recentExportPath, setRecentExportPath] = useState<string | null>(null);
  const [productIntroOpen, setProductIntroOpen] = useState(false);
  const productIntroAutoShownRef = useRef(false);
  const {
    notebookToDelete,
    notebookCreateRequest,
    cancelDeleteNotebook,
    confirmDeleteNotebook,
    createNotebook: handleCreateNotebook,
    deleteNotebook: handleDeleteNotebook,
    editNotebook: handleEditNotebook,
    openPlugin: handleOpenPlugin,
    switchFolderCollectionType: handleSwitchFolderCollectionType,
    selectNotebook: handleSelectNotebook,
  } = business;
  const {
    onboardingOpen,
    onboardingLoading,
    updater,
    hasPendingAppUpdateResult,
    presentPendingAppUpdateResult,
    completeOnboarding,
  } = system;
  const showProductIntroAfterOnboarding = useCallback(() => {
    if (productIntroAutoShownRef.current) return;
    productIntroAutoShownRef.current = true;

    try {
      if (window.localStorage.getItem(PRODUCT_INTRO_AUTO_SHOWN_KEY) === 'true') return;
      window.localStorage.setItem(PRODUCT_INTRO_AUTO_SHOWN_KEY, 'true');
    } catch {
      // Keep the in-memory guard so a storage failure cannot reopen it repeatedly.
    }

    setProductIntroOpen(true);
  }, []);

  useEffect(() => {
    if (!hasPendingAppUpdateResult
      || onboardingLoading
      || onboardingOpen
      || productIntroOpen) return;
    const frame = window.requestAnimationFrame(() => presentPendingAppUpdateResult());
    return () => window.cancelAnimationFrame(frame);
  }, [
    hasPendingAppUpdateResult,
    onboardingLoading,
    onboardingOpen,
    productIntroOpen,
    presentPendingAppUpdateResult,
  ]);
  // 切片订阅：每个 useStore 只取真正用到的字段，setter 走 useShallow 聚合。
  // 替代原来的 `useNoteStore()` / `useDocumentStore()` / `useSettingsStore()`
  // 全量订阅 —— 任何 set 都会让 MainLayout 整树重渲，跨菜单栏 / 状态栏 /
  // document 容器一起抖。切到 selector 后, 只在用到的字段变化时本组件
  // 才重渲, memo-list / document-container 各自独立订阅, 互不污染。
  const {
    selectedNotebook,
    startupPhase: memoStartupPhase,
    middleColumnView,
    activeFilter,
    activePluginId,
    activeSort,
    setActiveFilter,
    setMiddleColumnView,
    loadNotes,
    triggerRefresh,
  } = useShellMemoViewModel();
  const [defaultCreateFolderState, setDefaultCreateFolderState] = useState<{
    notebookId: string;
    path: string | null;
  } | null>(null);
  const defaultCreateFolder = defaultCreateFolderState !== null
    && selectedNotebook != null
    && defaultCreateFolderState.notebookId === selectedNotebook.id
    ? defaultCreateFolderState.path
    : null;
  useEffect(() => {
    let current = true;
    const refreshDefaultFolder = () => {
      if (!selectedNotebook) return;
      void files.getNotebookViewPreferences(selectedNotebook.path).then((preferences) => {
        if (current) setDefaultCreateFolderState({
          notebookId: selectedNotebook.id,
          path: preferences.defaultCreateFolder ?? null,
        });
      }).catch((error) => {
        logger.warn('load notebook default create folder for titlebar failed', { error, notebookId: selectedNotebook.id });
        if (current) setDefaultCreateFolderState({ notebookId: selectedNotebook.id, path: null });
      });
    };
    if (!selectedNotebook) {
      setDefaultCreateFolderState(null);
      return () => { current = false; };
    }
    refreshDefaultFolder();
    const unsubscribe = subscribe<{ notebookPath: string; defaultCreateFolderChanged: boolean }>(
      'notebook-view-preferences-changed',
      ({ notebookPath, defaultCreateFolderChanged }) => {
        if (defaultCreateFolderChanged
          && canonicalDirectoryPath(notebookPath) === canonicalDirectoryPath(selectedNotebook.path)) {
          refreshDefaultFolder();
        }
      },
    );
    return () => {
      current = false;
      unsubscribe();
    };
  }, [selectedNotebook?.id, selectedNotebook?.path]);
  const memoListView = useMemoListViewPreference();
  const isAgentConversationView = middleColumnView === 'conversations';
  const {
    currentDocumentPath,
    activeExternalSession,
    isDocumentTransitioning,
  } = useShellDocumentViewModel();

  const {
    memoListVisible,
    noteNavigationVisible,
    toolbarCollapsed,
    setMemoListVisible,
    setNoteNavigationVisible,
    setToolbarCollapsed,
  } = useSettingsStore(
    useShallow((s) => ({
      memoListVisible: s.memoListVisible,
      noteNavigationVisible: s.noteNavigationVisible,
      toolbarCollapsed: s.toolbarCollapsed,
      setMemoListVisible: s.setMemoListVisible,
      setNoteNavigationVisible: s.setNoteNavigationVisible,
      setToolbarCollapsed: s.setToolbarCollapsed,
    })),
  );
  const {
    navigation: navigationState,
    browserColumnVisible,
    browserColumnSplitRatio,
    setBrowserColumnSplitRatio,
    focusedHostId,
    notebookSwitching,
  } = useShellWorkspaceViewModel();
  const interactive = useWorkspaceStartupStore(isWorkspaceInteractive);
  const nativeStartup = useWorkspaceStartupStore(useShallow((state) => ({
    phase: state.nativePhase,
    stage: state.nativeStage,
    step: state.nativeStep,
    error: state.nativeError,
  })));
  // Only the failure banner reads this store. Subscribing to the whole store
  // re-rendered the entire layout (memo list, titlebar, status bar) on every
  // startup progress tick.
  const workspaceStartup = useWorkspaceStartupStore(useShallow((state) => ({
    status: state.status,
    error: state.error,
  })));
  // Native error UI remains in the layout; the root overlay owns all loading visuals.
  const startupStatus = nativeStartup;
  const documentHistory = useShellDocumentHistory();
  const canNavigateBack = documentHistory.backStack.some((entry) => (
    isDifferentHistoryTarget(
      entry,
      navigationState.target,
    )
  ));
  const canNavigateForward = documentHistory.forwardStack.some((entry) => (
    isDifferentHistoryTarget(
      entry,
      navigationState.target,
    )
  ));
  const [isSearchPanelOpen, setIsSearchPanelOpen] = useState(false);
  const workColumnTarget = navigationState.target;
  const mediaTarget = workColumnTarget.kind === 'media' ? workColumnTarget : null;
  const activePlugin = workColumnTarget.kind === 'plugin-workbench'
    ? workColumnTarget.plugin
    : null;
  const currentDocumentContentRef = useRef('');
  const currentDocumentEditorRef = useRef<Editor | null>(null);
  const {
    browserColumnLayout,
    browserColumnLayoutKey,
    collapseMemoList,
    handleBrowserColumnResize,
    resizeMemoList,
    setIsDraggingListDivider,
    handleToggleMemoList,
    handleToggleNoteNavigation,
    openNoteNavigation,
    closeNoteNavigation,
    completeNoteNavigationClose,
    isDraggingListDivider,
    isMemoListHidden,
    memoColWidth,
    noteNavigationPhase,
  } = useMainPanelController({
    browserColumnSplitRatio,
    documentPanelMinWidth: DOCUMENT_PANEL_MIN_WIDTH,
    memoListVisible,
    noteNavigationVisible,
    setBrowserColumnSplitRatio,
    setMemoListVisible,
    setNoteNavigationVisible,
  });
  const handleOpenTagPanel = useCallback(() => {
    void setMemoListViewPreference('detailed');
    setMiddleColumnView('notes');
    openNoteNavigation();
  }, [openNoteNavigation, setMiddleColumnView]);
  const {
    shouldRenderAgentConversationList,
    showMemoListSurface,
    memoListPreviewVisible,
    memoListPreviewPhase,
    handleMemoListPreviewTriggerEnter,
    handleMemoListPreviewTriggerLeave,
    handleMemoListPreviewEnter,
    handleMemoListPreviewLeave,
    handleMemoListPreviewCompanionEnter,
    handleMemoListPreviewCompanionLeave,
    agentConversationListNode,
  } = useMainMiddleColumnController({
    onConversationListBack: () => {
      void setMemoListViewPreference('folders');
      setMiddleColumnView('notes');
    },
    isAgentConversationView,
    isMemoListHidden,
    noteNavigationPhase,
  });
  const currentFileIdentity = activeExternalSession?.fileIdentity ?? null;
  const currentDocumentInstanceKey = currentFileIdentity?.displayId ?? null;
  const mainMemoEditorIdentity = activeExternalSession
    ? {
        kind: 'md' as const,
        path: activeExternalSession.fileIdentity.path,
        displayId: activeExternalSession.fileIdentity.displayId,
      }
    : null;
  const mainEditorMode = useDocumentEditorMode(
    'main-third',
    mainMemoEditorIdentity ?? {
      kind: 'md',
      path: currentDocumentPath ?? '',
      displayId: activeExternalSession?.fileIdentity.displayId ?? 'inactive-external-display',
    },
  );
  const getCurrentDocumentContent = useCallback(() => currentDocumentContentRef.current, []);
  const getCurrentDocumentEditor = useCallback(() => currentDocumentEditorRef.current, []);
  const handleDocumentEditorReady = useCallback((editor: Editor | null) => {
    currentDocumentEditorRef.current = editor;
  }, []);
  const handleDocumentExported = useCallback((filePath: string) => {
    setRecentExportPath(filePath);
  }, []);
  const {
    handleCopyFullText,
    handleCopyLink,
    handleExportMarkdown,
    handleSaveAsTemplate,
    handleExportWord,
    handleExportPdf,
  } = useDocumentCommands({
    currentDocumentPath,
    getCurrentDocumentContent,
    getCurrentDocumentEditor,
    onExported: handleDocumentExported,
  });

  const handleDeleteExternalFile = useCallback(async (expectedFilePath: string, notebookPath: string | null) => {
    try {
      const outcome = await deleteMainExternalDocument(expectedFilePath);
      if (outcome === 'unsaved') {
        toast.error(t('document.external.deleteFileUnsaved'));
        return;
      }
      if (outcome !== 'deleted') {
        if (!notebookPath) {
          toast.error('无法确定多维表格所属的笔记本，无法删除。');
          return;
        }
        const deleted = await files.delete(expectedFilePath, notebookPath);
        if (!deleted) throw new Error('删除多维表格失败');
        try {
          clearBrowserColumnExternalPath(expectedFilePath);
          await clearWorkspaceTargetForDeletedFile(expectedFilePath);
        } catch (cleanupError) {
          logger.warn('[MainLayout] File deleted, but workspace display cleanup failed:', {
            error: cleanupError,
            filePath: expectedFilePath,
          });
          toast.error(t('document.external.deleteFileViewCleanupFailed'));
        }
      }
    } catch (error) {
      logger.warn('[MainLayout] Failed to delete external file:', { error: error });
      toast.error(t('document.external.deleteFileFailed'));
    }
  }, [t]);

  useEffect(() => {
    const handleRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ filePath?: unknown; notebookPath?: unknown }>).detail;
      if (typeof detail?.filePath === 'string' && detail.filePath) {
        void handleDeleteExternalFile(detail.filePath, typeof detail.notebookPath === 'string' ? detail.notebookPath : null);
      }
    };
    window.addEventListener('flowix:request-delete-external-file', handleRequest);
    return () => window.removeEventListener('flowix:request-delete-external-file', handleRequest);
  }, [handleDeleteExternalFile]);

  // The DocumentContainer owns the import hook because it needs the editor's contentRef and saveDoc.
  // The titlebar renders the path, so it receives the container API through this bridge.
  // Keep the setter memoized so the container effect does not rerun on each parent render.
  useEffect(() => {
    currentDocumentContentRef.current = '';
    currentDocumentEditorRef.current = null;
    setRecentExportPath(null);
  }, [currentDocumentInstanceKey]);

  // Reset search when switching memos because results belong to the current editor state.
  // Results from the previous memo are no longer relevant after the switch.
  useEffect(() => {
    setIsSearchPanelOpen(false);
  }, [currentDocumentInstanceKey]);

  const handleOpenTodos = useCallback(async () => {
    const nextFilter = activeFilter === 'todos' ? 'all' : 'todos';
    setMemoListVisible(true);
    void setMemoListViewPreference('detailed');
    setMiddleColumnView('notes');
    setActiveFilter(nextFilter);
    await loadNotes({
      notebookId: selectedNotebook?.id,
      filter: nextFilter,
      sort: activeSort,
    });
  }, [
    activeFilter,
    activeSort,
    loadNotes,
    selectedNotebook?.id,
    setActiveFilter,
    setMemoListVisible,
    setMiddleColumnView,
  ]);

  const handleNavigateBack = useCallback(() => {
    void navigateDocumentHistory('back');
  }, []);

  const handleNavigateForward = useCallback(() => {
    void navigateDocumentHistory('forward');
  }, []);

  const handleCopyMediaLink = useCallback(async () => {
    if (!mediaTarget) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(mediaTarget.filePath);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = mediaTarget.filePath;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        textarea.style.pointerEvents = 'none';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      toast.success(t('document.command.copySuccess'));
    } catch (error) {
      logger.warn('[MainLayout] Failed to copy media link:', { error: error });
      toast.error(t('document.command.copyFailed'));
    }
  }, [mediaTarget, t]);

  const handleRevealMedia = useCallback(() => {
    if (!mediaTarget) return;
    void product.revealInFileManager(mediaTarget.filePath).catch((error) => {
      logger.warn('[MainLayout] Failed to reveal media in file manager:', { error: error });
      toast.error(t('memo.fileTree.openFailed'));
    });
  }, [mediaTarget, t]);

  const handleRequestDeleteMedia = useCallback(() => {
    if (!mediaTarget?.notebookPath) return;
    window.dispatchEvent(new CustomEvent('flowix:request-delete-media', {
      detail: {
        filePath: mediaTarget.filePath,
        notebookPath: mediaTarget.notebookPath,
      },
    }));
  }, [mediaTarget]);

  const handleSetMainEditorMode = useCallback((mode: DocumentEditorMode) => {
    if (!mainMemoEditorIdentity || mainEditorMode === mode) return;
    captureLatestDocumentContent(mainMemoEditorIdentity, 'main-third');
    setDocumentEditorMode('main-third', mainMemoEditorIdentity, mode);
  }, [mainEditorMode, mainMemoEditorIdentity]);
  const handleViewSourceMode = useCallback(() => handleSetMainEditorMode('source'), [handleSetMainEditorMode]);

  useEffect(() => {
    const handleViewSource = () => handleViewSourceMode();
    window.addEventListener('flowix:view-source-mode', handleViewSource);
    return () => window.removeEventListener('flowix:view-source-mode', handleViewSource);
  }, [handleViewSourceMode]);

  const workColumnDocument: DocumentSurfaceContext | null = currentDocumentPath && currentFileIdentity
    ? activeExternalSession ? {
          identity: {
            kind: 'external' as const,
            fileIdentity: activeExternalSession.fileIdentity,
            scopePath: activeExternalSession.scopePath,
            indexable: activeExternalSession.indexable,
            transitionId: activeExternalSession.transitionId,
          },
          instanceKey: activeExternalSession.fileIdentity.displayId,
          documentProps: {
            notebookId: activeExternalSession.notebookId ?? null,
            notebookPath: activeExternalSession.notebookPath ?? null,
            transitionId: activeExternalSession.transitionId,
            initialFocus: activeExternalSession.initialFocus,
            isExternalDocument: true,
            externalScopePath: activeExternalSession.scopePath,
            searchPanelOpen: isSearchPanelOpen,
            onSearchPanelOpenChange: setIsSearchPanelOpen,
            toolbarCollapsed,
            onToolbarCollapsedChange: setToolbarCollapsed,
            onMetainfoData: (data: { memoContent: string }) => {
              currentDocumentContentRef.current = data.memoContent;
            },
            onEditorReady: handleDocumentEditorReady,
          },
        } : null
    : null;
  const visibleNavigationState = selectedNotebook && (
    navigationState.target.kind === 'media'
    && navigationState.target.notebookId !== selectedNotebook.id
  ) ? { ...navigationState, target: { kind: 'empty' as const } } : navigationState;
  const workColumnPresentation = resolveWorkColumnPresentation({
    navigation: visibleNavigationState,
    document: workColumnDocument,
    pluginWorkbench: activePlugin
      ? {
          plugin: activePlugin,
          notebookPath: selectedNotebook?.path,
          currentNotePath: currentDocumentPath,
          currentNoteContent: currentDocumentContentRef.current,
        }
      : null,
    emptyMessage: t('shell.emptyDocument'),
  });
  // ── 手机单栏 ──────────────────────────────────────────────────────────
  // 窄视口下不做三栏并排: 有文档时整屏显示文档, 否则整屏显示列表。
  // 列表可临时覆盖回来 (标题栏侧栏按钮), 选中任意目标后自动收起覆盖。
  const mobileSingleColumn = useIsMobileViewport();
  const hasOpenWorkSurface = workColumnPresentation.content.status !== 'empty';
  const [mobileListOverlay, setMobileListOverlay] = useState(false);
  useEffect(() => {
    setMobileListOverlay(false);
  }, [mobileSingleColumn, navigationState.target]);
  const showMobileList = mobileSingleColumn && (mobileListOverlay || !hasOpenWorkSurface);
  const effectiveMemoListHidden = mobileSingleColumn ? !showMobileList : isMemoListHidden;
  const effectiveDocumentHidden = mobileSingleColumn && showMobileList;
  const effectiveBrowserColumnVisible = browserColumnVisible && !mobileSingleColumn;
  const toggleMobileList = useCallback(() => {
    setMobileListOverlay((visible) => !visible);
  }, []);
  const handleCollapseListColumn = mobileSingleColumn ? () => setMobileListOverlay(false) : collapseMemoList;
  const handleToggleListColumn = mobileSingleColumn ? toggleMobileList : handleToggleMemoList;
  // ── 侧栏动画掉帧修复 ────────────────────────────────────────────────
  // 侧栏宽度动画的每一帧都会强制右侧编辑器全量重排 (大 DOM 全宽折行),
  // 平板/手机上表现为明显丢帧。收起/展开的动画期间把文档列宽度冻结在
  // 当前值 (编辑器不重排, 释放的空间短暂留白), 结束后一次性回流填充。
  const listPaneRef = useRef<HTMLDivElement>(null);
  const paneUnfreezeTimerRef = useRef<number | null>(null);
  const [frozenListPaneWidth, setFrozenListPaneWidth] = useState<number | null>(null);
  const freezeListPaneDuringAnimation = useCallback(() => {
    if (mobileSingleColumn) return;
    const width = listPaneRef.current?.getBoundingClientRect().width;
    if (!width || width <= 0) return;
    setFrozenListPaneWidth(width);
    if (paneUnfreezeTimerRef.current != null) {
      window.clearTimeout(paneUnfreezeTimerRef.current);
    }
    paneUnfreezeTimerRef.current = window.setTimeout(() => setFrozenListPaneWidth(null), 220);
  }, [mobileSingleColumn]);
  const handleCollapseListColumnDesktop = useCallback(() => {
    freezeListPaneDuringAnimation();
    collapseMemoList();
  }, [collapseMemoList, freezeListPaneDuringAnimation]);
  const handleToggleListColumnDesktop = useCallback(() => {
    freezeListPaneDuringAnimation();
    handleToggleMemoList();
  }, [freezeListPaneDuringAnimation, handleToggleMemoList]);
  // 手机单栏: 列表里打开笔记 (含已打开的那条) 后收起覆盖层回到文档。
  useEffect(() => {
    if (!mobileSingleColumn) return;
    const handleOpenNote = () => setMobileListOverlay(false);
    window.addEventListener('flowix:open-note-from-list', handleOpenNote);
    return () => window.removeEventListener('flowix:open-note-from-list', handleOpenNote);
  }, [mobileSingleColumn]);
  // Android 返回键: 抽屉 → 文档返回列表 → 退出应用。
  useMobileBackButton({
    isMobile: isMobileDevice(),
    isDrawerOpen: noteNavigationPhase !== 'closed',
    isDocumentVisible: mobileSingleColumn && !showMobileList,
    onCloseDrawer: closeNoteNavigation,
    onShowList: () => setMobileListOverlay(true),
  });
  // 文档内容区手势: 下滑搜索 / 右滑列表 / 左滑目录。
  // 键盘 (输入面板) 弹起时整体禁用 ── 编辑态下文本选择/放大镜交回原生。
  const imeVisible = useImeVisible();
  const mobileGestureRef = useRef<HTMLDivElement>(null);
  const mobileListGestureRef = useRef<HTMLDivElement>(null);
  useMobileSwipeGestures({
    // 所有触屏设备 (含平板): 宽屏右滑呼出停靠侧栏, 窄屏右滑开覆盖层。
    enabled: isMobileDevice() && !showMobileList,
    disabled: imeVisible,
    targetRef: mobileGestureRef,
    onSwipeDown: () => window.dispatchEvent(new Event('flowix:open-palette')),
    onSwipeRight: () => {
      if (mobileSingleColumn) {
        setMobileListOverlay(true);
        return;
      }
      freezeListPaneDuringAnimation();
      void setMemoListVisible(true);
    },
    onSwipeLeft: () => window.dispatchEvent(new Event('flowix:open-outline')),
  });
  // 列表列手势 (反向收缩): 左滑收起覆盖层 (手机) 或停靠侧栏 (平板)。
  useMobileSwipeGestures({
    enabled: isMobileDevice(),
    disabled: imeVisible,
    targetRef: mobileListGestureRef,
    onSwipeDown: () => {},
    onSwipeRight: () => {
      if (!mobileSingleColumn) {
        freezeListPaneDuringAnimation();
        void setMemoListVisible(true);
      }
    },
    onSwipeLeft: () => {
      if (mobileSingleColumn) {
        setMobileListOverlay(false);
        return;
      }
      freezeListPaneDuringAnimation();
      void setMemoListVisible(false);
    },
  });
  const workSurfaceViewId = workColumnPresentation.content.status === 'surface'
    ? workColumnPresentation.content.surface.instanceKey
    : '';
  const workRuntimePresentation = useWorkspaceSurfacePresentation(workSurfaceViewId);
  const workSurfaceBlockingLoading = workRuntimePresentation.state?.status === 'loading'
    && workRuntimePresentation.state.loadingMode === 'blocking';
  const workSurfaceFailed = workRuntimePresentation.state?.status === 'error'
    || workRuntimePresentation.state?.status === 'unavailable';
  const effectiveWorkPresentation = resolveWorkColumnRuntimePresentation(
    workColumnPresentation,
    workRuntimePresentation,
    workColumnDocument?.identity,
  );
  const workCapabilities = effectiveWorkPresentation.capabilities;
  const workHeaderStyle = effectiveWorkPresentation.chrome;
  const isAgentConversationDetail = workColumnPresentation.header.kind === 'agent';
  const handleToggleDefaultFolder = useCallback(async (target: {
    filePath: string;
    notebookPath: string;
    notebookId: string;
  }) => {
    const folderPath = parentDirectoryPath(target.filePath, target.notebookPath);
    const relativeFolder = notebookRelativeDirectoryPath(target.notebookPath, folderPath);
    if (relativeFolder === null) return;
    try {
      const preferences = await files.getNotebookViewPreferences(target.notebookPath);
      const isDefaultFolder = (preferences.defaultCreateFolder ?? null) === relativeFolder;
      const nextDefaultFolder = isDefaultFolder ? null : relativeFolder;
      await files.setNotebookViewPreferences(target.notebookPath, {
        ...preferences,
        defaultCreateFolder: nextDefaultFolder,
      });
      setDefaultCreateFolderState({ notebookId: target.notebookId, path: nextDefaultFolder });
      toast.success(t(isDefaultFolder
        ? 'memo.fileTree.defaultCreateFolderCleared'
        : 'memo.fileTree.defaultCreateFolderSet'));
    } catch (error) {
      logger.warn('set default create folder from collection titlebar failed', { error, folderPath });
      toast.error(t('memo.fileTree.preferenceSaveFailed'));
    }
  }, [t]);
  const documentTitlebarProps = {
    reserveWindowsControls: !effectiveBrowserColumnVisible,
    surfaceChrome: workHeaderStyle === 'media' ? 'media' as const : 'document' as const,
    showEditorFontSwitcher: workColumnPresentation.content.status === 'surface'
      && workCapabilities.includes('edit')
      && workColumnPresentation.content.surface.kind === 'md',
    showEditorModeToggle: workColumnPresentation.content.status === 'surface'
      && workColumnPresentation.content.surface.kind === 'md',
    editorMode: mainEditorMode,
    onSetEditorMode: handleSetMainEditorMode,
    document: {
      target: workColumnPresentation.header.kind === 'document'
        && workColumnPresentation.header.document.externalFilePath
        && workColumnPresentation.content.status === 'surface'
        && 'fileIdentity' in workColumnPresentation.content.surface
        ? resolveDocumentTitlebarTarget(
            workColumnPresentation.content.surface.fileIdentity,
            activeExternalSession,
            selectedNotebook?.path ?? null,
          )
        : null,
    },
    sidebar: {
      hidden: effectiveMemoListHidden,
      noteNavigationVisible,
      onToggle: mobileSingleColumn ? handleToggleListColumn : handleToggleListColumnDesktop,
    },
    navigation: {
      canNavigateBack,
      canNavigateForward,
      onNavigateBack: handleNavigateBack,
      onNavigateForward: handleNavigateForward,
      title: workRuntimePresentation.title,
      icon: workRuntimePresentation.icon,
    },
    contentCapabilities: {
      copyFullText: workCapabilities.includes('copy-content'),
      memoColors: workCapabilities.includes('memo-colors'),
      exportContent: workCapabilities.includes('export-content'),
      saveAsTemplate: workCapabilities.includes('save-template'),
      versionHistory: workCapabilities.includes('version-history'),
    },
    actions: {
      onCopyLink: handleCopyLink,
      onCopyFullText: handleCopyFullText,
      onExportMarkdown: handleExportMarkdown,
      onSaveAsTemplate: handleSaveAsTemplate,
      onExportWord: handleExportWord,
      onExportPdf: handleExportPdf,
      onDeleteExternalFile: () => {
        const header = workColumnPresentation.header;
        if (header.kind === 'document' && header.document.externalFilePath) {
          void handleDeleteExternalFile(header.document.externalFilePath, selectedNotebook?.path ?? null);
        }
      },
    },
    mediaActions: mediaTarget ? {
      onCopyLink: handleCopyMediaLink,
      onRevealInFileManager: handleRevealMedia,
      onRequestDelete: handleRequestDeleteMedia,
    } : undefined,
    folderCollectionViewType: navigationState.target.kind === 'collection'
      && canonicalPath(navigationState.target.filePath).endsWith('/.index.yaml')
      && navigationState.target.notebookId
      ? {
          current: navigationState.target.collectionType,
          isDefaultFolder: defaultCreateFolderState?.notebookId === navigationState.target.notebookId
            && notebookRelativeDirectoryPath(
              navigationState.target.notebookPath,
              parentDirectoryPath(navigationState.target.filePath, navigationState.target.notebookPath),
            ) === defaultCreateFolder,
          onToggleDefaultFolder: () => {
            const target = navigationState.target;
            if (target.kind === 'collection') void handleToggleDefaultFolder({
              filePath: target.filePath,
              notebookPath: target.notebookPath,
              notebookId: target.notebookId,
            });
          },
          onSelect: (type: 'table' | 'media_library') => {
            const target = navigationState.target;
            if (target.kind !== 'collection' || target.collectionType === type) return;
            void handleSwitchFolderCollectionType({
              filePath: target.filePath,
              notebookPath: target.notebookPath,
              notebookId: target.notebookId,
            }, type);
          },
        }
      : undefined,
  };

  return (
    <div
      className="flowix-main-layout relative flex h-screen w-screen overflow-hidden"
      data-tauri-drag-region={!interactive || undefined}
      data-agent-conversation-view={isAgentConversationView || undefined}
      data-agent-conversation-detail={isAgentConversationDetail || undefined}
      style={{ backgroundColor: 'var(--frame-bg)' }}
    >
      <WindowsTitlebarControls />
      <SyncStatusPanel />
      {/* 移动端右侧 AI 侧边栏（当前文档关联会话）；桌面不渲染任何 DOM。 */}
      <MobileAgentPanel />
      {/* Keep window controls and startup retry UI outside the business barrier. */}
      <div className="contents" inert={!interactive} aria-busy={!interactive}>
      {interactive && <ExternalFileDropOverlay />}
      <div className="flex flex-1 overflow-hidden">
        <div className="flex flex-col flex-1 overflow-hidden">
          <div className={`relative flex flex-1 h-full overflow-hidden ${isWindowsPlatform() ? 'rounded-b-[12px]' : 'rounded-b-[18px]'} border-b border-[var(--divider)]`}>
          <NoteNavigationDrawer
            phase={noteNavigationPhase}
            selectedNotebook={selectedNotebook}
            onOpenPreferences={(tab) => void windows.openPreferences(tab)}
            activePluginId={activePluginId}
            onOpenPlugin={handleOpenPlugin}
            onRequestClose={closeNoteNavigation}
            onCloseComplete={completeNoteNavigationClose}
            onCompanionSurfaceEnter={handleMemoListPreviewCompanionEnter}
            onCompanionSurfaceLeave={handleMemoListPreviewCompanionLeave}
          />
          {/* List column: one mounted subtree shared by the docked sidebar and hover preview. */}
          <ListColumn
            hidden={effectiveMemoListHidden}
            previewVisible={memoListPreviewVisible}
            previewPhase={memoListPreviewPhase === 'open' ? 'open' : 'closing'}
            memoColWidth={memoColWidth}
            mobileFullWidth={mobileSingleColumn}
            containerRef={mobileListGestureRef}
            isDraggingListDivider={isDraggingListDivider}
            selectedNotebook={selectedNotebook}
            noteNavigationPhase={noteNavigationPhase}
            onCollapseMemoList={mobileSingleColumn ? handleCollapseListColumn : handleCollapseListColumnDesktop}
            onOpenPreferences={(tab) => void windows.openPreferences(tab)}
            onPreviewEnter={handleMemoListPreviewEnter}
            onPreviewLeave={handleMemoListPreviewLeave}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              const target = event.target;
              if (target instanceof Element && target.closest('[data-folder-selection]')) return;
              focusWorkspaceHostFromEvent(event, 'main-third');
            }}
          >
            <ListColumnContent
              activeView={middleColumnView === 'conversations'
                ? 'conversations'
                : memoListView === 'folders' ? 'folders' : 'cards'}
              onViewChange={(view) => {
                if (view === 'conversations') {
                  setMiddleColumnView('conversations');
                  return;
                }
                void setMemoListViewPreference(view === 'folders' ? 'folders' : 'detailed');
                setMiddleColumnView('notes');
              }}
              navigationDrawerOpen={noteNavigationPhase !== 'closed'}
              onToggleNavigationDrawer={handleToggleNoteNavigation}
              conversationList={shouldRenderAgentConversationList ? agentConversationListNode : undefined}
            >
              <MemoList
                navigationDrawerEnabled
                navigationDrawerOpen={noteNavigationPhase !== 'closed'}
                onToggleNavigationDrawer={handleToggleNoteNavigation}
                isActive={!isAgentConversationView}
                dataLoadingEnabled={!isAgentConversationView}
              />
            </ListColumnContent>
          </ListColumn>
          {/* List <-> Memo detail divider */}
          {!effectiveMemoListHidden && !mobileSingleColumn && (
            <div className="relative z-[60] h-full w-px shrink-0 bg-[var(--divider)]">
              <ColumnResizeHandle label="调整列表列宽度" width={memoColWidth} onResize={resizeMemoList} onDraggingChange={setIsDraggingListDivider} />
            </div>
          )}
          {/* Keep the drop overlay outside the scrolling columns so it covers the viewport. */}
          <div
            data-workspace-drop-overlay-host
            className={cn(
              'relative isolate flex min-h-0 min-w-0 flex-1 overflow-hidden',
              effectiveDocumentHidden && 'hidden',
            )}
          >
          <div
            data-document-columns-layout="split"
            className="relative isolate flex min-h-0 min-w-0 flex-1 flex-row overflow-x-auto overflow-y-hidden"
          >
          {/* Memo detail */}
            <div
              ref={(node) => {
                mobileGestureRef.current = node;
                listPaneRef.current = node;
              }}
              className="relative h-full min-w-0 flex flex-col bg-[var(--document-bg)]"
              style={frozenListPaneWidth != null
                ? { width: frozenListPaneWidth, minWidth: 0, flex: '0 0 auto' }
                : effectiveBrowserColumnVisible
                  ? {
                      minWidth: mobileSingleColumn ? 0 : DOCUMENT_PANEL_MIN_WIDTH,
                      flex: `0 0 ${browserColumnLayout.mainColumnWidth}px`,
                    }
                  : { minWidth: mobileSingleColumn ? 0 : DOCUMENT_PANEL_MIN_WIDTH, flex: 1 }}
              data-workspace-host="main-third"
              data-workspace-focused={focusedHostId === 'main-third' ? '' : undefined}
              onPointerDown={(event) => focusWorkspaceHostFromEvent(event, 'main-third')}
              onFocusCapture={(event) => focusWorkspaceHostFromEvent(event, 'main-third')}
            >
            {isMemoListHidden && !mobileSingleColumn && (
              <button
                type="button"
                data-memo-list-preview-edge-trigger
                onMouseEnter={handleMemoListPreviewTriggerEnter}
                onMouseLeave={handleMemoListPreviewTriggerLeave}
                // Clicking the collapsed edge follows the hover interaction:
                // open the floating preview instead of restoring the full
                // list column.
                onClick={handleMemoListPreviewEnter}
                aria-label={t('document.titlebar.showSidebar')}
                title={t('document.titlebar.showSidebarTooltip')}
                className="group absolute bottom-0 left-0 top-0 z-[60] flex w-4 items-center justify-center text-[var(--muted-foreground)] opacity-30 transition-[color,opacity] duration-150 hover:text-[var(--foreground)] hover:opacity-50 focus-visible:outline-none focus-visible:text-[var(--brand)] focus-visible:opacity-100"
              >
                <span className="flex translate-x-0 flex-col items-center gap-[6px]" aria-hidden="true">
                  <span className="h-1 w-1 rounded-full bg-current" />
                  <span className="h-1 w-1 rounded-full bg-current" />
                  <span className="h-1 w-1 rounded-full bg-current" />
                </span>
              </button>
            )}
            {/* Fixed top navigation bar */}
            {workColumnPresentation.header.kind === 'agent' ? (
              <AgentConversationTitlebar
                instanceId={workColumnPresentation.header.instanceId}
                reserveWindowsControls={!effectiveBrowserColumnVisible}
                isMiddleColumnCollapsed={effectiveMemoListHidden}
                isSidebarVisible={noteNavigationPhase !== 'closed'}
                onExpandSidebar={handleToggleListColumn}
                canNavigateBack={canNavigateBack}
                canNavigateForward={canNavigateForward}
                onNavigateBack={handleNavigateBack}
                onNavigateForward={handleNavigateForward}
              />
            ) : isWindowsPlatform() ? (
              <DocumentTitlebarWin {...documentTitlebarProps} />
            ) : (
              <DocumentTitlebarMac {...documentTitlebarProps} />
            )}

            {/* Content area */}
            <div className="relative isolate flex-1 min-w-0 overflow-hidden">
              {recentExportPath && workColumnPresentation.header.kind === 'document' && (
                <div className="absolute inset-x-0 top-0 z-50 flex h-[50px] items-center justify-center gap-2 border-b border-[var(--border)] bg-[color-mix(in_oklch,var(--card)_78%,transparent)] px-4 backdrop-blur-md">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="rounded-lg"
                    onClick={() => {
                      void product.revealInFileManager(recentExportPath).catch(() => {
                        toast.error(t('memo.fileTree.openFailed'));
                      });
                    }}
                  >
                    {t('document.exportNotice.openFolder')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="rounded-lg"
                    onClick={() => {
                      void openPath(recentExportPath).catch(() => {
                        toast.error(t('memo.fileTree.openFailed'));
                      });
                    }}
                  >
                    {t('memo.fileTree.openDefaultApp')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="rounded-lg"
                    onClick={() => setRecentExportPath(null)}
                    aria-label={t('document.exportNotice.close')}
                    title={t('document.exportNotice.close')}
                  >
                    {t('document.exportNotice.close')}
                  </Button>
                </div>
              )}
              <WorkColumnContentHost
                content={workColumnPresentation.content}
                focused={focusedHostId === 'main-third'}
                startupIdentity={JSON.stringify(navigationState.target)}
              />
              {((isDocumentTransitioning && !workSurfaceFailed)
                || workSurfaceBlockingLoading
                || (navigationState.phase === 'loading' && navigationState.showWorkColumnLoading)) && (
                <CenteredLoadingSpinner
                  className="pointer-events-none absolute inset-0 z-40"
                  label={notebookSwitching ? t('memo.navigation.preparingNotebook') : undefined}
                />
              )}
            </div>
          </div>
          {effectiveBrowserColumnVisible && (
            <Suspense fallback={null}>
              <BrowserColumn
                width={browserColumnLayout.browserColumnWidth}
                layoutKey={browserColumnLayoutKey}
                onResize={handleBrowserColumnResize}
                toolbarCollapsed={toolbarCollapsed}
                onToolbarCollapsedChange={setToolbarCollapsed}
              />
            </Suspense>
          )}
          </div>
          </div>
          </div>
          {/* Status bar */}
          <MainStatusBarHost
            onSelectNotebook={handleSelectNotebook}
            onEditNotebook={handleEditNotebook}
            onDeleteNotebook={handleDeleteNotebook}
            onCreateNotebook={handleCreateNotebook}
            onOpenTodos={handleOpenTodos}
            onOpenTagPanel={handleOpenTagPanel}
            productIntroOpen={productIntroOpen}
            onProductIntroOpenChange={setProductIntroOpen}
            updater={updater}
          />
        </div>
      </div>

      <NotebookDeleteDialog
        key={notebookToDelete?.id ?? 'closed'}
        target={notebookToDelete ? { id: notebookToDelete.id, name: notebookToDelete.name } : null}
        onCancel={cancelDeleteNotebook}
        onConfirm={confirmDeleteNotebook}
      />

      <MemoListServicesHost
        notebookCreateRequest={notebookCreateRequest}
        onRefresh={triggerRefresh}
        suppressEmptyNotebookPrompt={onboardingLoading || onboardingOpen}
      />

      </div>

      {(startupStatus.phase === 'failed'
        || workspaceStartup.status === 'failed'
        || (memoStartupPhase === 'error' && (!showMemoListSurface || isMemoListHidden))) && (
        <div className="absolute inset-0 z-[100] flex items-center justify-center bg-[var(--frame-bg)]">
          {startupStatus.phase === 'failed' ? (
            <div className="flex max-w-md flex-col items-center gap-3 px-6 text-center text-sm text-[var(--muted-foreground)]" role="alert">
              {t(startupStatus.stage === 'workspacePreparation'
                ? 'memo.navigation.workspacePreparationFailed'
                : 'memo.navigation.startupMigrationFailed')}
              {startupStatus.error && <span className="max-h-40 overflow-auto break-words">{startupStatus.error}</span>}
              <Button size="sm" className="rounded-lg" onClick={() => {
                void boot.retryStartup().then(() => window.location.reload()).catch((error) => {
                  useWorkspaceStartupStore.setState({ nativeError: String(error) });
                });
              }}>{t('error.retry')}</Button>
            </div>
          ) : (
            <div className="flex max-w-md flex-col items-center gap-3 px-6 text-center" role="alert">
              <span className="text-sm text-[var(--muted-foreground)]">{t(workspaceStartup.status === 'failed'
                ? 'memo.navigation.workspacePreparationFailed'
                : 'memo.list.loadFailed')}</span>
              {workspaceStartup.error && <span className="max-h-40 overflow-auto break-words text-sm text-[var(--muted-foreground)]">{workspaceStartup.error}</span>}
              <Button size="sm" className="rounded-lg" onClick={() => window.location.reload()}>{t('error.retry')}</Button>
            </div>
          )}
        </div>
      )}

      {onboardingOpen && (
        <OnboardingScreen
          onFinish={async (notebook, { startImport, templateId }) => {
            await finishOnboardingNotebook(notebook, { startImport, templateId }, {
              completeOnboarding,
              failureTitle: t('notebook.setup.failed'),
              retryLabel: t('error.retry'),
              overwriteConfirmMessage: t('notebook.template.overwriteConfirm'),
            });
            showProductIntroAfterOnboarding();
          }}
        />
      )}
    </div>
  );
}
