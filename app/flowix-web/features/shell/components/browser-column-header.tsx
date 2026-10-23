import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { Check, ChevronDown, ChevronRight, FilePlus2, MessageCirclePlus } from 'lucide-react';
import { classifyFileContent } from '@features/content/public/content-api';
import {
  type BrowserColumnTab,
} from '@features/workspace/public/browser-column-api';
import {
  AgentThreadCardFullscreenExitButton,
  useFullscreenAgentThreadCardInfo,
} from '@features/document/public/shell-api';
import {
  AgentIcon,
  requestNewConversationAgentSelection,
  useBrowserColumnAgentHeaderModel,
  useNewConversationAgentSelection,
} from '@features/agent/public/shell-api';
import type { BrowserColumnSurfaceChrome } from '@features/surface/public/shell-api';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { BrowserTabContextMenu } from './browser-tab-context-menu';
import { BrowserTabItem } from './browser-tab-item';
import { BrowserTabIcon } from './browser-tab-icon';
import { useBrowserTabSelection, type BrowserTabSelectionHandler } from '../hooks/use-browser-tab-selection';
import { useBrowserTabDrag } from '../hooks/use-browser-tab-drag';
import { BROWSER_TAB_SIZE, useBrowserTabLayout } from '../hooks/use-browser-tab-layout';
import { WORK_COLUMN_TITLEBAR_GRADIENT } from './work-column-titlebar-shell';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@shared/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@shared/ui/dropdown-menu';
import type { AgentTypeKey } from '@/types/agent';
import { useNotebookNoteIcons } from '@features/memo/public/shell-api';

function isWindowsPlatform(): boolean {
  return typeof navigator !== 'undefined'
    && (/Windows/i.test(navigator.userAgent) || /Win/i.test(navigator.platform));
}

export interface BrowserColumnHeaderProps {
  tabs: BrowserColumnTab[];
  activeTabId: string | null;
  activeSurfaceChrome: BrowserColumnSurfaceChrome;
  onSelectTab: BrowserTabSelectionHandler;
  onCloseTab: (tabId: string) => void | Promise<void>;
  onCloseOtherTabs: (tabId: string) => void | Promise<void>;
  onCloseTabsToRight: (tabId: string) => void | Promise<void>;
  onCloseAllTabs: () => void | Promise<void>;
  onToggleMemoEditorMode: (tabId: string) => void | Promise<void>;
  onOpenTabInWorkColumn: (tabId: string) => void | Promise<void>;
  onReorderTab: (tabId: string, beforeTabId: string | null) => void;
  isTabMenuOpen: boolean;
  onTabMenuOpenChange: (open: boolean) => void;
  onCloseColumn?: () => void;
  onContextMenuOpenChange: (tabId: string, open: boolean) => void;
  isFocused: boolean;
  canCreate: boolean;
  onCreateNote: () => void;
  onCreateAgentConversation: (typeKey: AgentTypeKey) => void;
}

export function BrowserColumnHeader({
  tabs,
  activeTabId,
  activeSurfaceChrome,
  onSelectTab,
  onCloseTab,
  onCloseOtherTabs,
  onCloseTabsToRight,
  onCloseAllTabs,
  onToggleMemoEditorMode,
  onOpenTabInWorkColumn,
  onReorderTab,
  isTabMenuOpen,
  onTabMenuOpenChange,
  onCloseColumn = () => {},
  onContextMenuOpenChange,
  isFocused,
  canCreate,
  onCreateNote,
  onCreateAgentConversation,
}: BrowserColumnHeaderProps) {
  const { t } = useI18n();
  const [agentTypeMenuAnchor, setAgentTypeMenuAnchor] = useState<{ left: number; top: number } | null>(null);
  const { conversationInstances } = useBrowserColumnAgentHeaderModel();
  const noteIconRequests = useMemo(() => tabs.flatMap((tab) => tab.target.kind === 'file-browser'
    && tab.target.activeFilePath && classifyFileContent(tab.target.activeFilePath) === 'note'
    ? [{ key: tab.id, notebookId: tab.target.notebookId, filePath: tab.target.activeFilePath }] : []), [tabs]);
  const noteIcons = useNotebookNoteIcons(noteIconRequests);
  const newConversationSelection = useNewConversationAgentSelection();
  const tabButtons = useRef(new Map<string, HTMLButtonElement>());
  const { displayedActiveTabId, selectTab } = useBrowserTabSelection({
    tabs, activeTabId, buttons: tabButtons, onSelectTab,
    onFailure: () => toast.error(t('tabWindow.switchFailed')),
  });
  const { tabListRef, compactTabs } = useBrowserTabLayout(tabs, displayedActiveTabId, tabButtons);
  const { draggedTabId, tabDragHandlers, endDropHandlers } = useBrowserTabDrag(onReorderTab);
  const isWindows = isWindowsPlatform();
  // A fullscreen Thread Card keeps its DOM position inside this column, so the
  // host-scoped info hook only fires for cards mounted in the browser column —
  // work-column fullscreen never reaches this header.
  const fullscreenInfo = useFullscreenAgentThreadCardInfo('browser-column');
  const isAgentSurface = activeSurfaceChrome === 'agent' || Boolean(fullscreenInfo);
  const isMediaSurface = activeSurfaceChrome === 'media';

  const tabLabel = (tab: BrowserColumnTab) => {
    if (tab.target.kind !== 'agent_conversation') return tab.title;
    const title = conversationInstances[tab.target.instanceId]?.title.trim();
    return title || tab.title;
  };
  const tabAgentTypeKey = (tab: BrowserColumnTab) => tab.target.kind === 'agent_conversation'
    ? conversationInstances[tab.target.instanceId]?.agentType
    : undefined;

  const openAgentTypeMenu = (event: MouseEvent<HTMLButtonElement>) => {
    const selection = requestNewConversationAgentSelection();
    if (selection.kind === 'create') {
      setAgentTypeMenuAnchor(null);
      onCreateAgentConversation(selection.agentType);
      return;
    }
    if (selection.kind === 'none') return;
    const rect = event.currentTarget.getBoundingClientRect();
    setAgentTypeMenuAnchor({ left: rect.right + 2, top: rect.top });
  };

  useEffect(() => {
    if (agentTypeMenuAnchor && newConversationSelection.kind !== 'choose') {
      setAgentTypeMenuAnchor(null);
    }
  }, [agentTypeMenuAnchor, newConversationSelection]);

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex = index;
    if (event.key === 'ArrowRight') nextIndex = Math.min(index + 1, tabs.length - 1);
    else if (event.key === 'ArrowLeft') nextIndex = Math.max(index - 1, 0);
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabs.length - 1;
    else return;

    event.preventDefault();
    const nextTab = tabs[nextIndex];
    const button = tabButtons.current.get(nextTab.id);
    button?.focus();
    button?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    void selectTab(nextTab.id);
  };

  return (
    <header
      data-browser-column-header
      data-tauri-drag-region
      data-thread-card-fullscreen={fullscreenInfo ? '' : undefined}
      className={cn(
        'relative flex shrink-0 items-center pl-1 pr-2',
        isWindows ? 'h-9 min-h-9 pr-[126px]' : 'h-12 min-h-12',
        isAgentSurface && 'agent-surface-titlebar',
        isMediaSurface && 'media-surface-titlebar',
      )}
      // Keep the tab strip visually continuous with the work-column titlebar.
      // The gradient remains visible around the individual tab cards.
      style={isAgentSurface || isMediaSurface ? undefined : { backgroundImage: WORK_COLUMN_TITLEBAR_GRADIENT }}
    >
      <button
        type="button"
        aria-label={t('tabWindow.closeColumn')}
        title={t('tabWindow.closeColumn')}
        onClick={onCloseColumn}
        className="flex h-8 w-8 shrink-0 items-center justify-center text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] [-webkit-app-region:no-drag]"
      >
        <ChevronRight className="h-4 w-4" />
      </button>
      <div
        ref={tabListRef}
        role="tablist"
        aria-label={t('tabWindow.openContent')}
        data-tauri-drag-region
        className="flex h-10 min-h-10 min-w-0 flex-1 items-center gap-0.5 overflow-x-auto overflow-y-hidden p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((tab, index) => {
          const selected = tab.id === displayedActiveTabId;
          const iconOnlyTab = compactTabs && !selected;
          // 仅激活 tab 会挂载内容，全屏卡片必然在其中 ── 全屏期间激活
          // tab 换成 Agent 图标 + 对话标题，退出后回退 tab 自身标题。
          const tabFullscreen = tab.id === activeTabId && fullscreenInfo
            ? { title: fullscreenInfo.title || tab.title, typeKey: fullscreenInfo.typeKey }
            : null;
          const displayedTabTitle = tabFullscreen?.title ?? tabLabel(tab);
          return (
            <ContextMenu
              key={tab.id}
              onOpenChange={(open) => onContextMenuOpenChange(tab.id, open)}
            >
              <ContextMenuTrigger asChild>
                <BrowserTabItem
                  draggable
                  {...tabDragHandlers(tab.id, tabs[index + 1]?.id ?? null)}
                  selected={selected}
                  iconOnly={iconOnlyTab}
                  focused={isFocused}
                  dragging={draggedTabId === tab.id}
                  title={displayedTabTitle}
                  icon={tabFullscreen ? <AgentIcon typeKey={tabFullscreen.typeKey} alt="" className="h-3.5 w-3.5" /> : <BrowserTabIcon tab={tab} agentTypeKey={tabAgentTypeKey(tab)} noteIcon={noteIcons[tab.id]} />}
                  closeLabel={t('tabWindow.closeTab', { title: displayedTabTitle })}
                  buttonRef={(node) => {
                    if (node) tabButtons.current.set(tab.id, node);
                    else tabButtons.current.delete(tab.id);
                  }}
                  onSelect={() => { void selectTab(tab.id); }}
                  onTabKeyDown={(event) => handleKeyDown(event, index)}
                  onClose={() => { void onCloseTab(tab.id); }}
                />
              </ContextMenuTrigger>
              <BrowserTabContextMenu tab={tab} index={index} tabCount={tabs.length}
                onCloseTab={onCloseTab}
                onCloseOtherTabs={onCloseOtherTabs}
                onCloseTabsToRight={onCloseTabsToRight}
                onCloseAllTabs={onCloseAllTabs}
                onToggleMemoEditorMode={onToggleMemoEditorMode}
                onOpenTabInWorkColumn={onOpenTabInWorkColumn}
              />
            </ContextMenu>
          );
        })}
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              {...endDropHandlers}
              data-browser-tab-drop-end
              data-tauri-drag-region
              aria-hidden="true"
              style={{ height: BROWSER_TAB_SIZE.height, minWidth: BROWSER_TAB_SIZE.trailing }}
              className="flex-1 self-stretch [-webkit-app-region:no-drag]"
            />
          </ContextMenuTrigger>
          <ContextMenuContent className="w-[180px] space-y-0.5 rounded-xl p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
            <ContextMenuItem
              disabled={!canCreate}
              onClick={onCreateNote}
              className="h-7 items-center justify-start gap-0 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
            >
              <FilePlus2 className="mr-2 h-4 w-4" />
              <span className="leading-5">{t('tabWindow.context.newNote')}</span>
            </ContextMenuItem>
            <ContextMenuItem
              disabled={!canCreate || newConversationSelection.kind === 'none'}
              onClick={openAgentTypeMenu}
              className="h-7 items-center justify-start gap-0 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
            >
              <MessageCirclePlus className="mr-2 h-4 w-4" />
              <span className="flex-1 leading-5">{t('tabWindow.context.newConversation')}</span>
              <ChevronRight className="ml-2 h-3.5 w-3.5" />
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </div>
      <DropdownMenu
        open={agentTypeMenuAnchor !== null}
        onOpenChange={(open) => { if (!open) setAgentTypeMenuAnchor(null); }}
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            className="pointer-events-none fixed h-px w-px opacity-0"
            style={agentTypeMenuAnchor ?? { left: -100, top: -100 }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          side="bottom"
          sideOffset={0}
          className="w-[200px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]"
        >
          <DropdownMenuLabel className="flex items-center gap-1.5 px-[0.375rem] pb-[0.35rem] pt-[0.35rem] text-xs font-normal leading-[1.2] text-[var(--muted-foreground)]">
            {t('tabWindow.context.newConversation')}
          </DropdownMenuLabel>
          {newConversationSelection.options.map((type) => {
            const name = type.nameKey
              ? t(type.nameKey as Parameters<typeof t>[0])
              : type.name;
            return (
              <DropdownMenuItem
                key={type.id}
                onClick={() => {
                  setAgentTypeMenuAnchor(null);
                  onCreateAgentConversation(type.id);
                }}
                className="agent-conversation-new-agent-item group h-7 items-center justify-start gap-2 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
              >
                <AgentIcon typeKey={type.id} alt="" className="h-4 w-4 shrink-0 object-contain" />
                <span className="min-w-0 flex-1 truncate">{name}</span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      {/* 全屏 Thread Card 接管本列内容区时，退出按钮落在浏览器列头部，
          紧邻右侧的下拉按钮左侧，与第三列 titlebar 的 exit 按钮同一组件/样式，
          仅 host 作用域不同。 */}
      <AgentThreadCardFullscreenExitButton
        host="browser-column"
        className="agent-thread-card-fullscreen-exit-btn"
      />
      <div className="h-8 w-8 shrink-0 pr-0.5 [-webkit-app-region:no-drag]">
        <DropdownMenu
          className="[-webkit-app-region:no-drag]"
          open={isTabMenuOpen}
          onOpenChange={onTabMenuOpenChange}
        >
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t('tabWindow.showAll')}
                title={t('tabWindow.showAll')}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)] [-webkit-app-region:no-drag]"
              >
                <ChevronDown className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              side="bottom"
              sideOffset={4}
              className="max-h-[min(420px,calc(100vh-16px))] w-[210px] rounded-xl overflow-y-auto p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]"
            >
              <DropdownMenuLabel className="px-2 py-1 text-xs font-medium text-[var(--muted-foreground)]">
                {t('tabWindow.all')}
              </DropdownMenuLabel>
              <div className="space-y-0.5">
                {tabs.map((tab) => {
                  const selected = tab.id === displayedActiveTabId;
                  return (
                    <DropdownMenuItem
                      key={tab.id}
                      title={tabLabel(tab)}
                      onClick={() => { void selectTab(tab.id); }}
                      className="group h-7 gap-1 rounded-lg px-2 py-0 hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
                    >
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center text-[var(--muted-foreground)] group-hover:text-[var(--primary-foreground)]">
                        {<BrowserTabIcon tab={tab} agentTypeKey={tabAgentTypeKey(tab)} noteIcon={noteIcons[tab.id]} />}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-left">{tabLabel(tab)}</span>
                      {selected && <Check className="h-3.5 w-3.5 shrink-0 text-[var(--brand)] group-hover:text-[var(--primary-foreground)]" />}
                    </DropdownMenuItem>
                  );
                })}
              </div>
            </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
