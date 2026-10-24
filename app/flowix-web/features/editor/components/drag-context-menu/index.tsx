import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
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
import { renderDragIcon } from '@features/editor/components/drag-context-menu/icons'
import type { BlockMenuItem } from '@features/editor/components/drag-context-menu/items'
import { clearBlockSelection } from '@features/editor/extensions/block-selection'
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
  const openMenuRef = useRef<(anchorRect?: DOMRect, placeAtPointer?: boolean) => void>(() => {})
  const state = useDragHandlePosition(editor, fontSize, lineHeight, ignoreBlur, menuOpenRef, menuTargetRef, hoveredBlockRef)
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

    // ── 触屏长按唤出块手柄 ─────────────────────────────────────────────
    // 触屏没有 hover, 手柄此前只能由指针悬停驱动, 手机上永远不出现。
    // 长按 (~480ms) 目标块即定位手柄; 位移超过阈值(滚动)或提前抬手则取消。
    let pressTimer: number | null = null
    let pressPoint: { x: number; y: number } | null = null
    let longPressFired = false

    const clearPressTimer = () => {
      if (pressTimer != null) {
        window.clearTimeout(pressTimer)
        pressTimer = null
      }
      pressPoint = null
    }

    const clearTouchHandle = () => {
      if (menuOpenRef.current || isDraggingRef.current) return
      if (!hoveredBlockRef.current) return
      hoveredBlockRef.current = null
      state.refresh()
    }

    const handleTouchPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') return
      if (menuOpenRef.current || isDraggingRef.current) return
      longPressFired = false
      const info = getBlockInfoAtCoords(editor, event.clientX, event.clientY)
      if (!info) return
      pressPoint = { x: event.clientX, y: event.clientY }
      pressTimer = window.setTimeout(() => {
        pressTimer = null
        pressPoint = null
        longPressFired = true
        if (editor.isDestroyed || editor.view.isDestroyed) return
        hoveredBlockRef.current = info
        state.refresh()
      }, 480)
    }

    const handleTouchPointerMove = (event: PointerEvent) => {
      if (event.pointerType !== 'touch' || !pressPoint) return
      if (Math.hypot(event.clientX - pressPoint.x, event.clientY - pressPoint.y) > 8) {
        clearPressTimer()
      }
    }

    const handleTouchPointerUp = () => {
      if (pressTimer == null && !longPressFired) return
      const wasLongPress = longPressFired
      clearPressTimer()
      longPressFired = false
      // 普通点按用于编辑内容: 收起上次长按留下的手柄。
      if (!wasLongPress) clearTouchHandle()
    }

    /**
     * Right-click on a block opens the same action menu as the drag handle.
     * The browser menu is suppressed only when a block can actually be
     * resolved, so right-clicking outside the document keeps native behavior.
     */
    const handleContextMenu = (event: MouseEvent) => {
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
    surface.addEventListener('pointermove', handlePointerMove)
    surface.addEventListener('pointerleave', handlePointerLeave)
    surface.addEventListener('contextmenu', handleContextMenu)
    surface.addEventListener('pointerdown', handleTouchPointerDown)
    surface.addEventListener('pointermove', handleTouchPointerMove)
    surface.addEventListener('pointerup', handleTouchPointerUp)
    surface.addEventListener('pointercancel', handleTouchPointerUp)
    return () => {
      if (frame != null) window.cancelAnimationFrame(frame)
      surface.removeEventListener('pointermove', handlePointerMove)
      surface.removeEventListener('pointerleave', handlePointerLeave)
      surface.removeEventListener('contextmenu', handleContextMenu)
      surface.removeEventListener('pointerdown', handleTouchPointerDown)
      surface.removeEventListener('pointermove', handleTouchPointerMove)
      surface.removeEventListener('pointerup', handleTouchPointerUp)
      surface.removeEventListener('pointercancel', handleTouchPointerUp)
      clearPressTimer()
    }
  }, [editor, state.refresh])

  useEffect(() => {
    const handleBlur = () => {
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
      closeMenu()
    }

    scrollTarget.addEventListener('scroll', closeOnScroll, { passive: true })
    window.addEventListener('resize', closeMenu)
    window.addEventListener('scroll', closeOnScroll, true)

    return () => {
      scrollTarget.removeEventListener('scroll', closeOnScroll)
      window.removeEventListener('resize', closeMenu)
      window.removeEventListener('scroll', closeOnScroll, true)
    }
  }, [showMenu, editor, closeMenu])

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
    setShowMenu(true)
  }, [editor, interactionBlockInfoRef, state.blockInfo])
  openMenuRef.current = openMenu

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
          display: state.visible ? 'flex' : 'none',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'auto',
          zIndex: 1,
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
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onLostPointerCapture={onLostPointerCapture}
      >
        {renderDragIcon(state.blockInfo)}
      </div>
      {showMenu && typeof document !== 'undefined' && createPortal(
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
