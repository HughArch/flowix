import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Editor } from '@tiptap/core'
import {
  activateAgentThreadCard,
  getBlockInfoAtCoords,
  getBlockInfoForInteraction,
  type CurrentBlockInfo,
} from '@features/editor/components/drag-context-menu/block-info'
import {
  applyMenuItem,
  deleteBlock,
  insertParagraphAtEdge,
  setImageAlignment,
  pinBlock,
  unpinBlock,
} from '@features/editor/components/drag-context-menu/actions'
import {
  useBlockDragGesture,
} from '@features/editor/components/drag-context-menu/use-block-drag-gesture'
import { isMobileDevice } from '@shared/platform'
import { renderDragIcon } from '@features/editor/components/drag-context-menu/icons'
import type { BlockMenuItem } from '@features/editor/components/drag-context-menu/items'
import {
  clearBlockSelection,
  getBlockSelection,
  type BlockSelectionRange,
} from '@features/editor/extensions/block-selection'
import { useMobileBlockSelection } from '@features/editor/components/drag-context-menu/use-mobile-block-selection'
import { MobileSelectionDots } from '@features/editor/components/drag-context-menu/mobile-selection-dots'
import {
  MobileBlockSelectionBar,
  MobileBlockSheet,
  type MobileSheetAction,
} from '@features/editor/components/drag-context-menu/mobile-block-sheet'
import {
  blockInfoForPos,
  copyBlocksToClipboard,
  cutBlocksToClipboard,
  moveSelectedBlocks,
  pasteBlocksFromClipboard,
  selectAllTopLevelBlocks,
} from '@features/editor/components/drag-context-menu/block-clipboard'
import {
  FLOWIX_TEXT_COLORS,
  setFlowixTextStyle,
} from '@features/editor/extensions/flowix-text-mark'
import { toast } from '@/lib/toast'
import { useI18n } from '@/lib/i18n'
import { useMobileChromeStore } from '@features/document/public/shell-api'
import { fitTableToWidth } from '@features/editor/extensions/table/table-fit-width'
import {
  getTableTextAlign,
  setTableTextAlign,
  type TableTextAlign,
} from '@features/editor/extensions/table/table-text-align'
import { HANDLE_SIZE } from '@features/editor/components/drag-context-menu/style'
import { useDragHandlePosition } from '@features/editor/components/drag-context-menu/use-drag-handle-position'
import { BlockActionMenu } from '@features/editor/components/drag-context-menu/block-action-menu'
import { getTableHeaderState, useBlockMenuActions, type BlockBackgroundMenuState, type ColumnMenuState } from '@features/editor/components/drag-context-menu/block-menu-actions'
import {
  getFlowixBlockBackground,
  hasFlowixBlockBackgroundTargets,
  setFlowixBlockBackground,
} from '@features/editor/extensions/flowix-block-background'
import type { FlowixTextColor } from '@features/editor/extensions/flowix-text-mark'
import {
  addColumnBesideBlock,
  canSplitBlockToColumns,
  deleteColumn,
  findColumnContainer,
  splitBlocksIntoColumns,
} from '@features/editor/extensions/columns/columns-commands'
import { MAX_COLUMNS } from '@features/editor/extensions/columns/columns-markdown'
import { useEditorTypography } from '@features/preferences/public/runtime-api'

interface DragContextMenuProps {
  editor: Editor
}

function colorSwatchIcon(color: FlowixTextColor | null): ReactNode {
  return (
    <span
      aria-hidden="true"
      className="mobile-color-swatch"
      style={color ? { background: `var(--flowix-text-${color})` } : undefined}
    />
  )
}

interface MenuViewportPosition {
  left: number
  top: number
}

const MENU_GAP = 8
const MENU_VIEWPORT_PADDING = 8
// 底部状态栏 (h-6 = 24px) 会遮挡太贴近视口底部的弹窗 —
// 留出 30px 净空让菜单至少停在状态栏之上约 6px。
const MENU_BOTTOM_CLEARANCE = 30
export function DragContextMenu({ editor }: DragContextMenuProps) {
  // 字体/行高 (Preferences → Format) — 走窄 selector, 只在这两值变化时
  // 重渲染, 避免 theme / personalize / shortcuts 改动把整个组件拉一遍。
  // 这两个值进 useEffect deps, slider 拖动时 handle 跟着重新锚定。
  const { fontSize, lineHeight } = useEditorTypography()
  const { t } = useI18n()

  // 触屏 (手机 WebView) 走一套完全不同的交互:
  //   行前不常驻抓手 → 点行才出现抓手 → 点抓手进入选中 → 长按抓手上下滑动
  //   批量多选 → 底部工具栏剪贴。桌面保留原有的悬浮菜单 + 拖动换位。
  const isTouchMode = isMobileDevice()
  /** 底部操作条显示与否 / 选中行数。由 blockSelection 插件状态驱动。 */
  const [selectedBlockCount, setSelectedBlockCount] = useState(0)
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false)
  const [mobileSheetMode, setMobileSheetMode] = useState<'convert' | 'color'>('convert')

  const [showMenu, setShowMenu] = useState(false)
  const [isHovered, setIsHovered] = useState(false)
  const [menuPosition, setMenuPosition] = useState<MenuViewportPosition | null>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [menuInputMode, setMenuInputMode] = useState<'mouse' | 'keyboard'>('mouse')
  const [menuTarget, setMenuTarget] = useState<CurrentBlockInfo | null>(null)
  const [menuBlockBackground, setMenuBlockBackground] = useState<FlowixTextColor | null>(null)
  const [menuBlockBackgroundAvailable, setMenuBlockBackgroundAvailable] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const hoveredBlockRef = useRef<CurrentBlockInfo | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const ignoreBlur = useRef(false)
  const menuOpenRef = useRef(false)
  const menuTargetRef = useRef<CurrentBlockInfo | null>(null)
  const menuAnchorRectRef = useRef<DOMRect | null>(null)
  const menuAnchorFromPointerRef = useRef(false)
  /** 菜单打开时间戳: 用于忽略键盘收起引起的瞬时 resize/scroll。 */
  const menuOpenedAtRef = useRef(0)
  const openMenuRef = useRef<(anchorRect?: DOMRect, placeAtPointer?: boolean) => void>(() => {})
  const state = useDragHandlePosition(editor, fontSize, lineHeight, ignoreBlur, menuOpenRef, menuTargetRef, hoveredBlockRef, isTouchMode)
  const handleTap = useCallback((anchorRect: DOMRect) => openMenuRef.current(anchorRect), [])

  const handleBlockDragStart = useCallback(() => {
    // The drag plugin captured the block ranges already; drop the static
    // selection decorations so only the drag-source styling remains.
    clearBlockSelection(editor)
    menuOpenRef.current = false
    menuTargetRef.current = null
    menuAnchorRectRef.current = null
    setShowMenu(false)
    setIsHovered(false)
    setMenuTarget(null)
  }, [editor])
  const {
    isDragging,
    interactionBlockInfoRef,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onLostPointerCapture,
  } = useBlockDragGesture({
    editor,
    blockInfo: state.blockInfo,
    ignoreBlurRef: ignoreBlur,
    onDragStart: handleBlockDragStart,
    onTap: handleTap,
  })

  useEffect(() => {
    menuOpenRef.current = showMenu
  }, [showMenu])

  // 触屏: 抓手不再走"拖动换位置"的手势, 改用点击选中 / 长按滑动扩选。
  // 桌面仍走 useBlockDragGesture, 两者对 pointermove 的解释相反, 不能共用。
  const mobileGesture = useMobileBlockSelection({
    editor,
    blockInfo: state.blockInfo,
    ignoreBlurRef: ignoreBlur,
    onActivate: (info) => {
      hoveredBlockRef.current = info
      state.refresh()
    },
  })
  // 多选态下正文任意位置的长按由原生 pointerdown 监听发起, 经 ref 取
  // 最新的手势实例, 避免把每渲染次变化的对象塞进 effect 依赖。
  const mobileGestureRef = useRef(mobileGesture)
  mobileGestureRef.current = mobileGesture
  const selectionActiveRef = useRef(false)
  selectionActiveRef.current = selectedBlockCount > 0

  const selectedRanges = useCallback(
    (): BlockSelectionRange[] => getBlockSelection(editor.state)?.ranges ?? [],
    [editor],
  )

  // 底部操作条跟随 blockSelection 插件的状态: 该状态存在 ProseMirror 里,
  // 不经过 React, 因此用 transaction 事件把它同步到本地 state。
  useEffect(() => {
    if (!isTouchMode || !editor?.view || editor.view.isDestroyed) return
    const sync = () => {
      if (editor.isDestroyed) return
      setSelectedBlockCount(getBlockSelection(editor.state)?.ranges.length ?? 0)
    }
    sync()
    editor.on('transaction', sync)
    return () => {
      editor.off('transaction', sync)
    }
  }, [editor, isTouchMode])

  // 选中被清空 (点正文 / Esc / 剪贴完成) 时收起底部弹层, 避免留下空壳。
  useEffect(() => {
    if (selectedBlockCount === 0) setMobileSheetOpen(false)
  }, [selectedBlockCount])

  // 多选模式 (选中数 > 0): 行尾切换为小圆点 + 整行色带 (截图样式),
  // 通过根类名让 CSS 接管选中态视觉; 退出时移除。同时给编辑器表面打上
  // data-mobile-swipe-ignore, 多选态下的下滑不再触发搜索面板手势。
  useEffect(() => {
    if (!isTouchMode) return
    document.documentElement.classList.toggle('flowix-touch-selecting', selectedBlockCount > 0)
    if (selectedBlockCount > 0) {
      // 圆点层接管行尾, 抓手不再需要锚点。
      hoveredBlockRef.current = null
    }
    const surface = editor.view.dom.closest('.editor-content') as HTMLElement | null
    surface?.setAttribute('data-mobile-swipe-ignore', '')
    return () => {
      document.documentElement.classList.remove('flowix-touch-selecting')
      surface?.removeAttribute('data-mobile-swipe-ignore')
    }
  }, [editor, isTouchMode, selectedBlockCount])

  // 进入多选的瞬间收起软键盘 (参考 Flowus): 选中是批处理意图, 键盘只会
  // 挡住底部菜单。只在 0 → N 的跳变时收一次, 之后点圆点不再打断。
  const prevSelectionCountRef = useRef(0)
  useEffect(() => {
    if (!isTouchMode) return
    if (prevSelectionCountRef.current === 0 && selectedBlockCount > 0) {
      editor.commands.blur()
    }
    prevSelectionCountRef.current = selectedBlockCount
  }, [editor, isTouchMode, selectedBlockCount])

  // 多选期间强制只收起底部状态栏 (标题栏保持可用), 退出时还原。
  const selectionActive = selectedBlockCount > 0
  useEffect(() => {
    if (!isTouchMode) return
    if (!selectionActive) return
    useMobileChromeStore.getState().setStatusBarHidden(true)
    return () => useMobileChromeStore.getState().setStatusBarHidden(false)
  }, [isTouchMode, selectionActive])

  // 多选态下点击编辑器与底部面板之外 (标题栏空白 / 其他浮层外区域等)
  // = 取消多选。编辑器内由行点击/圆点接管, 不走这里。
  useEffect(() => {
    if (!isTouchMode || !selectionActive) return
    const onDocPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null
      if (!target) return
      if (
        target.closest('.editor-content')
        || target.closest('[role="toolbar"]')
        || target.closest('[aria-label="转换为"]')
        || target.closest('[aria-label="着色"]')
        || target.closest('.mobile-right-drawer')
      ) return
      ;[...document.querySelectorAll<HTMLElement>('[role="toolbar"] button')]
        .find((button) => button.textContent === '完成')
        ?.click()
    }
    document.addEventListener('pointerdown', onDocPointerDown, true)
    return () => document.removeEventListener('pointerdown', onDocPointerDown, true)
  }, [isTouchMode, selectionActive])

  const closeMobileSheet = useCallback(() => setMobileSheetOpen(false), [])

  const finishMobileSelection = useCallback(() => {
    clearBlockSelection(editor)
    setMobileSheetOpen(false)
    hoveredBlockRef.current = null
    state.refresh()
  }, [editor, state.refresh])

  const handleMobileCopy = useCallback(() => {
    const ranges = selectedRanges()
    if (copyBlocksToClipboard(editor, ranges)) toast.success(t('editor.block.copySuccess'))
    else toast.error(t('editor.block.clipboardFailed'))
  }, [editor, selectedRanges, t])

  const handleMobileCut = useCallback(() => {
    const ranges = selectedRanges()
    if (cutBlocksToClipboard(editor, ranges)) {
      toast.success(t('editor.block.cutSuccess'))
      setMobileSheetOpen(false)
      hoveredBlockRef.current = null
      state.refresh()
    } else {
      toast.error(t('editor.block.clipboardFailed'))
    }
  }, [editor, selectedRanges, state.refresh, t])

  const handleMobilePaste = useCallback(() => {
    const ranges = selectedRanges()
    // 有选中行时粘贴到第一行之前, 否则插到当前光标处。
    const at = ranges[0]?.from
    void pasteBlocksFromClipboard(editor, at).then((ok) => {
      if (!ok) toast.error(t('editor.block.clipboardFailed'))
      setMobileSheetOpen(false)
      hoveredBlockRef.current = null
      state.refresh()
    })
  }, [editor, selectedRanges, state.refresh, t])

  const handleMobileSelectAll = useCallback(() => {
    selectAllTopLevelBlocks(editor)
  }, [editor])

  const handleMobileDelete = useCallback(() => {
    const ranges = selectedRanges()
    if (ranges.length === 0) return
    const tr = editor.state.tr
    for (const range of [...ranges].sort((a, b) => b.from - a.from)) {
      const node = editor.state.doc.nodeAt(range.from)
      if (!node) continue
      tr.delete(range.from, range.from + node.nodeSize)
    }
    if (tr.docChanged) editor.view.dispatch(tr)
    clearBlockSelection(editor)
    setMobileSheetOpen(false)
    hoveredBlockRef.current = null
    state.refresh()
  }, [editor, selectedRanges, state.refresh])

  // 选中块 → 完整块信息 + PM 选区挪进该块。"转换为"的 toggle 与"着色"的
  // 文字样式都作用于 PM 选区, 不挪会命中光标所在行而不是选中的行。
  const prepareSelectedBlock = useCallback(() => {
    const first = selectedRanges()[0]
    const info = first ? blockInfoForPos(editor, first.from) : null
    if (!info) return null
    menuTargetRef.current = info
    setMenuTarget(info)
    if (info.nodeSize > 2) {
      editor.commands.setTextSelection({
        from: info.pos + 1,
        to: info.pos + info.nodeSize - 1,
      })
    }
    return info
  }, [editor, selectedRanges])

  const openMobileSheet = useCallback((mode: 'convert' | 'color') => {
    if (!prepareSelectedBlock()) return
    setMobileSheetMode(mode)
    setMobileSheetOpen(true)
  }, [prepareSelectedBlock])

  const handleMobileConvert = useCallback(() => openMobileSheet('convert'), [openMobileSheet])
  const handleMobileColor = useCallback(() => openMobileSheet('color'), [openMobileSheet])

  const handleMobileInsert = useCallback((side: 'before' | 'after') => {
    const info = prepareSelectedBlock()
    if (!info) return
    insertParagraphAtEdge(editor, info, side)
    setMobileSheetOpen(false)
  }, [editor, prepareSelectedBlock])

  const handleMobileMove = useCallback((direction: -1 | 1) => {
    if (moveSelectedBlocks(editor, direction)) setMobileSheetOpen(false)
  }, [editor])

  // Follow the block under the pointer. Selection-driven positioning alone
  // would force a click into the body before every Mod-click on another row,
  // and that click clears the block selection. Hover keeps the handle
  // reachable without touching the editor selection.
  const isDraggingRef = useRef(false)
  useEffect(() => {
    isDraggingRef.current = isDragging
  }, [isDragging])

  useEffect(() => {
    if (!editor?.view || editor.view.isDestroyed) return
    const viewDom = editor.view.dom as HTMLElement
    const surface = (viewDom.closest('.editor-content') as HTMLElement | null) ?? viewDom
    hoveredBlockRef.current = null
    let frame: number | null = null
    let lastPoint: { x: number; y: number } | null = null

    const flush = () => {
      frame = null
      if (!lastPoint || menuOpenRef.current || isDraggingRef.current) return
      if (editor.isDestroyed || editor.view.isDestroyed) return
      const previous = hoveredBlockRef.current
      // Stay anchored while the pointer is on the handle or in the narrow
      // strip between the block and the handle. Re-resolving here can pick a
      // different block (or null) and hide the handle mid-approach.
      const handleRect = containerRef.current?.getBoundingClientRect()
      const nearHandle = !!handleRect
        && lastPoint.x >= handleRect.left - 16
        && lastPoint.x <= handleRect.right + 16
        && lastPoint.y >= handleRect.top - 16
        && lastPoint.y <= handleRect.bottom + 16
      if (nearHandle && previous) return

      // In a column the handle lives in the block's left gutter, where
      // `posAtCoords` cannot resolve a block. Keep the current target while
      // the pointer stays on that gutter row.
      if (previous) {
        const blockRect = previous.dom.getBoundingClientRect()
        const inLeftGutter = lastPoint.x < blockRect.left
          && lastPoint.y >= blockRect.top - 12
          && lastPoint.y <= blockRect.bottom + 12
        if (inLeftGutter) return
      }

      // Moving onto the handle itself must not re-target (or hide) it.
      const hit = document.elementFromPoint(lastPoint.x, lastPoint.y)
      if (hit instanceof Node && containerRef.current?.contains(hit)) return

      const info = getBlockInfoAtCoords(editor, lastPoint.x, lastPoint.y)
      if (!info) {
        // Do not leave the handle parked on a stale block when the pointer
        // no longer resolves to one; fall back to the selection position.
        if (!previous) return
        hoveredBlockRef.current = null
        state.refresh()
        return
      }
      if (previous && previous.pos === info.pos && previous.typeName === info.typeName) return
      hoveredBlockRef.current = info
      state.refresh()
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return
      lastPoint = { x: event.clientX, y: event.clientY }
      if (frame != null) return
      frame = window.requestAnimationFrame(flush)
    }

    const handlePointerLeave = (event: PointerEvent) => {
      // 触屏在抬手时必然派发 pointerleave, 不能据此隐藏手柄, 否则长按
      // 刚唤出的菜单会立刻消失; 触屏改由下一次点击或菜单关闭来清理。
      if (event.pointerType === 'touch') return
      // Moving from the editor surface onto the handle must not clear the
      // hover; the handle is often rendered outside the scroll surface.
      if (event.relatedTarget instanceof Node && containerRef.current?.contains(event.relatedTarget)) return
      lastPoint = null
      if (menuOpenRef.current || isDraggingRef.current) return
      if (!hoveredBlockRef.current) return
      hoveredBlockRef.current = null
      state.refresh()
    }

    // ── 触屏: 正文区域的统一按下入口 ───────────────────────────────────
    // 非多选态: 点中某一行时把抓手停到那一行 (行前不常驻抓手)。
    // 多选态: 任意位置长按 → 圈选手势 (范围内行批量加入多选); 轻点行 →
    // 切换该行选中 (手势 startPress 的 tap 分支)。抓手 / 圆点自己的
    // React handler 优先, 这里跳过。桌面不接管。
    const handleSurfacePointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse') return
      if (!isMobileDevice()) return
      if (!editor.isEditable || editor.isDestroyed || editor.view.isDestroyed) return
      if (containerRef.current?.contains(event.target as Node)) return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('.mobile-selection-dot')) return
      if (selectionActiveRef.current) {
        event.preventDefault()
        // 底部面板上沿的贴边条带: 点这里视觉上像点菜单, 实际会命中面板
        // 遮住的那行 ── 直接吞掉, 不进选中手势。
        const bar = document.querySelector('[role="toolbar"]')
        if (bar && event.clientY >= bar.getBoundingClientRect().top - 12) return
        const info = getBlockInfoAtCoords(editor, event.clientX, event.clientY)
        if (!info) return
        mobileGestureRef.current.startPress(info, event.clientX, event.clientY, event.pointerId)
        return
      }
      const info = getBlockInfoAtCoords(editor, event.clientX, event.clientY)
      if (!info) return
      hoveredBlockRef.current = info
      state.refresh()
    }

    /**
     * Right-click on a block opens the same action menu as the drag handle.
     * The browser menu is suppressed only when a block can actually be
     * resolved, so right-clicking outside the document keeps native behavior.
     */
    const handleContextMenu = (event: MouseEvent) => {
      // 移动端长按 = 系统文本选择: Android WebView 会派发 contextmenu,
      // 这里不再借它打开块菜单 (改由双击触发)。
      if (isMobileDevice()) return
      if (!editor.isEditable || editor.isDestroyed || editor.view.isDestroyed) return
      if (containerRef.current?.contains(event.target as Node)) return
      const info = getBlockInfoAtCoords(editor, event.clientX, event.clientY)
      if (!info) return
      event.preventDefault()
      event.stopPropagation()
      // A right-click can blur the editor before React commits the menu;
      // keep the blur handler from immediately closing it.
      ignoreBlur.current = true
      window.setTimeout(() => { ignoreBlur.current = false }, 0)
      interactionBlockInfoRef.current = info
      openMenuRef.current(new DOMRect(event.clientX, event.clientY, 1, 1), true)
    }

    // Pressing into the body does NOT clear the block selection: users often
    // click a line to focus it before extending the selection, and that click
    // must not discard blocks they already picked. The set is cleared by a
    // plain handle click (menu), Escape, or the start of a drag instead.
    // 任务复选框: tiptap 的 change 处理会 focus 编辑器 → 移动端弹起软键盘。
    // 拦截 pointerdown 会连带吞掉 click/change 导致勾选失效 (已踩坑),
    // 因此改为在 change 之后立即移除编辑器焦点: 勾选生效, 键盘收回。
    const handleTaskCheckboxChange = () => {
      window.setTimeout(() => {
        if (!editor.isDestroyed && editor.isFocused) editor.commands.blur()
      }, 0)
    }

    surface.addEventListener('pointermove', handlePointerMove)
    surface.addEventListener('pointerleave', handlePointerLeave)
    surface.addEventListener('contextmenu', handleContextMenu)
    surface.addEventListener('change', handleTaskCheckboxChange)
    surface.addEventListener('pointerdown', handleSurfacePointerDown)
    return () => {
      if (frame != null) window.cancelAnimationFrame(frame)
      surface.removeEventListener('pointermove', handlePointerMove)
      surface.removeEventListener('pointerleave', handlePointerLeave)
      surface.removeEventListener('contextmenu', handleContextMenu)
      surface.removeEventListener('change', handleTaskCheckboxChange)
      surface.removeEventListener('pointerdown', handleSurfacePointerDown)
    }
  }, [editor, state.refresh])

  useEffect(() => {
    const handleBlur = () => {
      // 菜单已打开时不因编辑器失焦而关闭: 移动端点抓手会先让输入法/编辑器
      // 失焦, 菜单刚弹出就被 blur 关掉。菜单由「点击外部」或选择菜单项关闭,
      // 两条路径在桌面端都有; 这里只负责"无菜单时的清理"。
      if (menuOpenRef.current) return
      if (!ignoreBlur.current) {
        menuOpenRef.current = false
        menuTargetRef.current = null
        menuAnchorRectRef.current = null
        setShowMenu(false)
        setIsHovered(false)
        setMenuTarget(null)
        interactionBlockInfoRef.current = null
        unpinBlock(editor)
        window.requestAnimationFrame(state.refresh)
      }
    }

    editor.on('blur', handleBlur)
    return () => {
      editor.off('blur', handleBlur)
    }
  }, [editor, state.refresh])

  const updateMenuPosition = useCallback(() => {
    if (!containerRef.current || !menuRef.current) return
    const liveHandleRect = containerRef.current.getBoundingClientRect()
    // Right-click anchors the menu at the pointer; the drag handle may be
    // parked on a different block.
    const pointerAnchor = menuAnchorFromPointerRef.current ? menuAnchorRectRef.current : null
    // Prefer live geometry after opening so normal reflows remain anchored;
    // fall back to the pointerdown snapshot only when the handle is hidden.
    const handleRect = pointerAnchor
      ?? (liveHandleRect.width > 0 && liveHandleRect.height > 0
        ? liveHandleRect
        : menuAnchorRectRef.current ?? liveHandleRect)
    const menuRect = menuRef.current.getBoundingClientRect()
    const rightSpace = window.innerWidth - handleRect.right - MENU_GAP - MENU_VIEWPORT_PADDING
    const leftSpace = handleRect.left - MENU_GAP - MENU_VIEWPORT_PADDING
    const placeRight = rightSpace >= menuRect.width || rightSpace >= leftSpace
    const preferredLeft = placeRight
      ? handleRect.right + MENU_GAP
      : handleRect.left - MENU_GAP - menuRect.width
    const preferredTop = handleRect.top

    setMenuPosition({
      left: clamp(preferredLeft, MENU_VIEWPORT_PADDING, window.innerWidth - menuRect.width - MENU_VIEWPORT_PADDING),
      top: clamp(preferredTop, MENU_VIEWPORT_PADDING, window.innerHeight - menuRect.height - MENU_BOTTOM_CLEARANCE),
    })
  }, [])

  const closeMenu = useCallback(() => {
    menuOpenRef.current = false
    menuTargetRef.current = null
    menuAnchorRectRef.current = null
    menuAnchorFromPointerRef.current = false
    unpinBlock(editor)
    setMenuPosition(null)
    setIsHovered(false)
    setShowMenu(false)
    setMenuTarget(null)
    interactionBlockInfoRef.current = null
    window.requestAnimationFrame(state.refresh)
  }, [editor, interactionBlockInfoRef, state.refresh])

  useLayoutEffect(() => {
    if (!showMenu) return
    updateMenuPosition()
  }, [showMenu, state.x, state.y, updateMenuPosition])

  useEffect(() => {
    if (!showMenu) return
    // showMenu 可能在 editor 销毁之后还变化 (e.g. 卸载过程)
    // 此时 editor.view.dom 会触发 view-not-available 警告。
    if (editor.isDestroyed) return

    const editorDom = editor.view.dom as HTMLElement
    const scrollContainer = editorDom.closest('.editor-content') as HTMLElement | null
    const scrollTarget = scrollContainer || editorDom
    const closeOnScroll = (event: Event) => {
      const target = event.target
      if (target instanceof Node && menuRef.current?.contains(target)) return
      // 打开后的极短时间内忽略 scroll: 收起软键盘引起的布局回流会派发
      // scroll 事件, 否则菜单同样会立即消失。
      if (Date.now() - menuOpenedAtRef.current < 350) return
      closeMenu()
    }

    // 视口变化 (移动端收起软键盘 → content padding 改变) 会触发 resize。
    // 这里只重新定位菜单, 不能关闭: 打开菜单时会主动 blur 编辑器收起键盘,
    // 若 resize 关菜单, 用户会看到菜单"一闪而过"。
    const handleWindowResize = () => updateMenuPosition()

    scrollTarget.addEventListener('scroll', closeOnScroll, { passive: true })
    window.addEventListener('resize', handleWindowResize)
    window.addEventListener('scroll', closeOnScroll, true)

    return () => {
      scrollTarget.removeEventListener('scroll', closeOnScroll)
      window.removeEventListener('resize', handleWindowResize)
      window.removeEventListener('scroll', closeOnScroll, true)
    }
  }, [showMenu, editor, closeMenu, updateMenuPosition])

  // Click outside both the handle and the portalled menu dismisses the menu
  // and drops the pin.
  useEffect(() => {
    if (!showMenu) return

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node
      if (containerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      closeMenu()
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showMenu, closeMenu])

  const onMenuItem = useCallback((item: BlockMenuItem) => {
    applyMenuItem(editor, item, menuTarget)
    menuOpenRef.current = false
    menuTargetRef.current = null
    menuAnchorRectRef.current = null
    setShowMenu(false)
    // 鼠标停在菜单项上(handle 之外),hover 态必须强制清零;
    // 否则 applyMenuItem 触发 selectionUpdate 把 handle 挪到新位置后,
    // 残留的 isHovered=true 会让新位置的 handle 误显 hover 背景。
    setIsHovered(false)
    // The transformed block may be at a different position; drop the pin
    // so the next selectionUpdate can re-pin to the new block.
    unpinBlock(editor)
    setMenuTarget(null)
  }, [editor, menuTarget])

  const onDelete = useCallback(() => {
    deleteBlock(editor, menuTarget)
    // The menu receives focus while it is open. Restore ProseMirror focus
    // after the document transaction so the next Mod/Ctrl+Z is owned by the
    // body history rather than by the menu or another native field.
    editor.view.focus()
    menuOpenRef.current = false
    menuTargetRef.current = null
    menuAnchorRectRef.current = null
    setShowMenu(false)
    // 同 onMenuItem: 鼠标在菜单项上(handle 外),hover 态强制清零。
    setIsHovered(false)
    // The deleted node is gone — drop the pin. The plugin's docChanged
    // handler additionally re-validates any stale pin position.
    unpinBlock(editor)
    setMenuTarget(null)
  }, [editor, menuTarget])
  const onImageAlign = useCallback((alignment: 'left' | 'center' | 'right') => {
    setImageAlignment(editor, alignment, menuTarget)
    menuOpenRef.current = false
    menuTargetRef.current = null
    menuAnchorRectRef.current = null
    setShowMenu(false)
    setIsHovered(false)
    unpinBlock(editor)
    setMenuTarget(null)
  }, [editor, menuTarget])
  const onTableHeaderToggle = useCallback((header: 'row' | 'column') => {
    if (header === 'row') {
      editor.chain().focus().toggleHeaderRow().run()
    } else {
      editor.chain().focus().toggleHeaderColumn().run()
    }
    closeMenu()
  }, [closeMenu, editor])
  const onTableFitWidth = useCallback(() => {
    if (!menuTarget) return
    fitTableToWidth(editor, menuTarget.pos)
    editor.view.focus()
    closeMenu()
  }, [closeMenu, editor, menuTarget])
  const onTableTextAlign = useCallback((align: TableTextAlign) => {
    if (!menuTarget) return
    setTableTextAlign(editor, menuTarget.pos, align)
    editor.view.focus()
    closeMenu()
  }, [closeMenu, editor, menuTarget])
  const onInsertParagraph = useCallback((side: 'before' | 'after') => {
    if (!menuTarget) return
    insertParagraphAtEdge(editor, menuTarget, side)
    editor.view.focus()
    closeMenu()
  }, [closeMenu, editor, menuTarget])
  const columnMenu = useMemo<ColumnMenuState | undefined>(() => {
    if (!menuTarget) return undefined
    const doc = editor.state.doc
    const info = findColumnContainer(doc, menuTarget.pos)
    const topNode = doc.nodeAt(menuTarget.pos)
    const isColumns = topNode?.type.name === 'columns'
    const canSplit = canSplitBlockToColumns(editor, menuTarget.pos)
    if (!info && !canSplit && !isColumns) return undefined

    const run = (operation: () => void) => {
      operation()
      closeMenu()
    }

    const columnCount = info?.columnsNode.childCount ?? (isColumns ? topNode!.childCount : 2)

    return {
      inColumn: !!info,
      canSplit,
      canInsertColumn: columnCount < MAX_COLUMNS,
      canDeleteColumn: !!info,
      onInsertColumn: (side) => run(() => {
        addColumnBesideBlock(editor, menuTarget.pos, side)
      }),
      onSplitInto: (count) => run(() => {
        splitBlocksIntoColumns(editor, menuTarget.pos, count, undefined, { onlyTarget: true })
      }),
      onDeleteColumn: () => run(() => {
        const current = findColumnContainer(doc, menuTarget.pos)
        if (current) deleteColumn(editor, current.columnsPos, current.columnIndex)
      }),
    }
  }, [closeMenu, editor, menuTarget])
  const blockBackgroundMenu = useMemo<BlockBackgroundMenuState | undefined>(() => {
    if (!menuTarget || !menuBlockBackgroundAvailable) return undefined
    return {
      current: menuBlockBackground,
      onChange: (color) => {
        setFlowixBlockBackground(editor, color, { targetPos: menuTarget.pos })
        // The operation is complete, so drop the handle-built block selection.
        // Otherwise clearing the colour would reveal the selection tint again
        // and read as a coloured row instead of "no background".
        clearBlockSelection(editor)
        closeMenu()
      },
    }
  }, [closeMenu, editor, menuBlockBackground, menuBlockBackgroundAvailable, menuTarget])

  const menuActions = useBlockMenuActions(
    onMenuItem,
    onDelete,
    menuTarget?.typeName,
    onImageAlign,
    menuTarget?.typeName === 'table' ? getTableHeaderState(menuTarget.node) : undefined,
    menuTarget?.typeName === 'table' ? getTableTextAlign(menuTarget.node) : undefined,
    onTableHeaderToggle,
    onTableTextAlign,
    onTableFitWidth,
    onInsertParagraph,
    columnMenu,
    blockBackgroundMenu,
  )

  const openMenu = useCallback((anchorRect?: DOMRect, placeAtPointer = false) => {
    const info = interactionBlockInfoRef.current ?? getBlockInfoForInteraction(editor, state.blockInfo)
    if (!info) return

    // Set this synchronously. The AgentThreadCard composer can blur the outer
    // editor before React's post-commit effect runs.
    menuOpenRef.current = true
    menuOpenedAtRef.current = Date.now()
    menuTargetRef.current = info
    menuAnchorRectRef.current = anchorRect ?? containerRef.current?.getBoundingClientRect() ?? null
    menuAnchorFromPointerRef.current = placeAtPointer
    setMenuTarget(info)
    interactionBlockInfoRef.current = null
    activateAgentThreadCard(editor, info)
    pinBlock(editor, info)
    // Snapshot the shared line-background state for the menu rows. The command
    // still re-resolves its targets when a swatch is picked, so a block
    // selection built through the handle fans out to every chosen row.
    setMenuBlockBackground(getFlowixBlockBackground(editor, { targetPos: info.pos }))
    setMenuBlockBackgroundAvailable(hasFlowixBlockBackgroundTargets(editor, { targetPos: info.pos }))
    setMenuPosition(null)
    setIsHovered(false)
    setSelectedIndex(0)
    setMenuInputMode('mouse')
    // 触屏没有浮动菜单: 任何 openMenu 请求 (含外接键盘 Enter) 都落到底部弹层。
    if (isTouchMode) {
      setMobileSheetOpen(true)
      return
    }
    setShowMenu(true)
  }, [editor, interactionBlockInfoRef, isTouchMode, state.blockInfo])
  openMenuRef.current = openMenu

  // "转换为"弹层只保留块类型转换分组 (标题 / 列表 / 引用 / 代码块),
  // 菜单项执行完自动收起弹层, 不要求用户再点一次 "完成"。
  // 标题项在桌面菜单里展示为 markdown 符号 (#/##), 移动端换成可读文案。
  // "着色"弹层 = 行背景 + 文字颜色 两组色板, 选择后面板保持打开方便试色。
  const mobileSheetActions = useMemo<MobileSheetAction[]>(() => {
    if (mobileSheetMode === 'color') {
      const targetPos = selectedRanges()[0]?.from ?? null
      const closeAfter = (fn: () => void) => () => {
        fn()
        setMobileSheetOpen(false)
      }
      const lineBgActions: MobileSheetAction[] = [
        {
          id: 'line-bg-section',
          group: 'background',
          icon: null,
          label: '',
          sectionLabel: t('editor.highlight.lineBackground'),
          onSelect: () => {},
        },
        {
          id: 'line-bg-default',
          group: 'background',
          icon: colorSwatchIcon(null),
          label: t('editor.highlight.default'),
          onSelect: closeAfter(() => setFlowixBlockBackground(editor, null, { targetPos })),
        },
        ...FLOWIX_TEXT_COLORS.map((color): MobileSheetAction => ({
          id: `line-bg-${color}`,
          group: 'background',
          icon: colorSwatchIcon(color),
          label: t(`editor.highlight.${color}`),
          onSelect: closeAfter(() => setFlowixBlockBackground(editor, color, { targetPos })),
        })),
      ]
      const fgActions: MobileSheetAction[] = [
        {
          id: 'fg-section',
          group: 'background',
          icon: null,
          label: '',
          sectionLabel: t('editor.highlight.foreground'),
          onSelect: () => {},
        },
        {
          id: 'fg-default',
          group: 'background',
          icon: colorSwatchIcon(null),
          label: t('editor.highlight.default'),
          onSelect: () => setFlowixTextStyle(editor, { fg: null }),
        },
        ...FLOWIX_TEXT_COLORS.map((color): MobileSheetAction => ({
          id: `fg-${color}`,
          group: 'background',
          icon: colorSwatchIcon(color),
          label: t(`editor.highlight.${color}`),
          onSelect: () => setFlowixTextStyle(editor, { fg: color }),
        })),
      ]
      return [...lineBgActions, ...fgActions]
    }

    return menuActions
      .filter((action) => action.group === 'heading' || action.group === 'list' || action.group === 'block')
      .map((action) => {
        const headingLevel = /^h([1-4])$/.exec(action.id)?.[1]
        const label = headingLevel
          ? t(`preferences.shortcuts.action.editor.setHeading${headingLevel}.title` as never)
          : action.label
        return {
          ...action,
          label,
          onSelect: () => {
            action.onSelect()
            setMobileSheetOpen(false)
          },
          children: action.children?.map((child) => ({
            ...child,
            onSelect: () => {
              child.onSelect()
              setMobileSheetOpen(false)
            },
          })),
        }
      })
  }, [editor, menuActions, mobileSheetMode, selectedRanges, t])

  const handleMenuHover = (index: number) => {
    setMenuInputMode('mouse')
    setSelectedIndex(index)
  }

  const selectCurrentMenuAction = () => {
    const action = menuActions[selectedIndex]
    if (action) action.onSelect()
  }

  const moveSelection = (direction: 1 | -1) => {
    const count = menuActions.length
    if (count === 0) return
    setSelectedIndex((index) => (index + direction + count) % count)
  }

  const handleMenuKeyDown = (e: KeyboardEvent | globalThis.KeyboardEvent) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      setMenuInputMode('keyboard')
      moveSelection(-1)
      return true
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      e.stopPropagation()
      setMenuInputMode('keyboard')
      moveSelection(1)
      return true
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      e.stopPropagation()
      setMenuInputMode('keyboard')
      moveSelection(e.shiftKey ? -1 : 1)
      return true
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      selectCurrentMenuAction()
      return true
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closeMenu()
      return true
    }
    return false
  }

  useEffect(() => {
    if (!showMenu) return

    const frameId = window.requestAnimationFrame(() => {
      ignoreBlur.current = true
      // 触屏上点抓手/长按时软键盘常还开着: 菜单聚焦会自动让输入框失焦,
      // 键盘随之收起, 而菜单因 menuOpenRef 守卫保留。
      menuRef.current?.focus({ preventScroll: true })
      window.setTimeout(() => {
        ignoreBlur.current = false
      }, 0)
    })

    return () => window.cancelAnimationFrame(frameId)
  }, [showMenu])

  const toggleMenu = () => {
    if (showMenu) {
      closeMenu()
    } else {
      openMenu()
    }
  }

  const onHandleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (showMenu && handleMenuKeyDown(e)) {
      return
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      toggleMenu()
    }
  }

  return (
    <>
      <div
        ref={containerRef}
        data-editor-preserve-focus-on-pointerdown="true"
        role="button"
        aria-haspopup="menu"
        aria-expanded={showMenu}
        tabIndex={state.visible ? 0 : -1}
        className={`drag-context-menu-handle${showMenu ? ' active' : ''}`}
        style={{
          position: 'absolute',
          left: `${state.x}px`,
          top: `${state.y}px`,
          width: `${HANDLE_SIZE}px`,
          height: `${HANDLE_SIZE}px`,
          // 多选模式下行尾交给小圆点层, 抓手让位。
          display: state.visible && !(isTouchMode && selectedBlockCount > 0) ? 'flex' : 'none',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'auto',
          // 行尾抓手必须压过 overlay 滚动条轨道 (z=2), 否则滚动后右缘被
          // 轨道截胡, 点抓手没反应; 仍低于抽屉 (149/150) 与底部面板 (155+)。
          zIndex: 30,
          background: showMenu ? 'var(--brand)' : (isHovered ? 'var(--muted)' : 'transparent'),
          color: showMenu ? 'var(--primary-foreground)' : 'var(--brand)',
          borderRadius: '4px',
          cursor: isDragging ? 'grabbing' : 'pointer',
          touchAction: 'none',
          boxShadow: 'none',
        }}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        onMouseDown={(e) => {
          ignoreBlur.current = true
          window.setTimeout(() => {
            ignoreBlur.current = false
          }, 0)
          if (showMenu) {
            e.preventDefault()
          }
        }}
        onKeyDown={onHandleKeyDown}
        onPointerDown={isTouchMode ? mobileGesture.onPointerDown : onPointerDown}
        onPointerMove={isTouchMode ? undefined : onPointerMove}
        onPointerUp={isTouchMode ? undefined : onPointerUp}
        onPointerCancel={isTouchMode ? undefined : onPointerCancel}
        onLostPointerCapture={isTouchMode ? undefined : onLostPointerCapture}
      >
        {renderDragIcon(state.blockInfo)}
      </div>
      {/* 多选模式: 行尾小圆点 (已选实心 / 未选空心), 点选 + 长按滑动扩选。 */}
      {isTouchMode && selectedBlockCount > 0 && (
        <MobileSelectionDots editor={editor} gesture={mobileGesture} />
      )}
      {/* 桌面: 悬浮菜单贴在抓手旁。触屏走底部弹层, 不再渲染这个浮层。 */}
      {!isTouchMode && showMenu && typeof document !== 'undefined' && createPortal(
        <BlockActionMenu
          actions={menuActions}
          selectedIndex={selectedIndex}
          mouseHoverEnabled={menuInputMode === 'mouse'}
          menuRef={(node) => {
            menuRef.current = node
          }}
          style={getMenuStyle(menuPosition)}
          onHover={handleMenuHover}
          onKeyDown={handleMenuKeyDown}
        />,
        document.body,
      )}
      {isTouchMode && (
        <>
          <MobileBlockSelectionBar
            count={selectedBlockCount}
            showMore={selectedBlockCount === 1}
            actions={{
              onSelectAll: handleMobileSelectAll,
              onCopy: handleMobileCopy,
              onCut: handleMobileCut,
              onPaste: handleMobilePaste,
              onDelete: handleMobileDelete,
              onMore: handleMobileConvert,
              onColor: handleMobileColor,
              onInsertAbove: () => handleMobileInsert('before'),
              onInsertBelow: () => handleMobileInsert('after'),
              onMoveUp: () => handleMobileMove(-1),
              onMoveDown: () => handleMobileMove(1),
              onDone: finishMobileSelection,
            }}
          />
          <MobileBlockSheet
            open={mobileSheetOpen}
            title={mobileSheetMode === 'color' ? t('editor.block.coloring') : t('editor.block.convertTo')}
            actions={mobileSheetActions}
            onClose={closeMobileSheet}
          />
        </>
      )}
    </>
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

function getMenuStyle(position: MenuViewportPosition | null): CSSProperties {
  return {
    left: position ? `${position.left}px` : '-9999px',
    top: position ? `${position.top}px` : '-9999px',
    minWidth: 180,
  }
}
