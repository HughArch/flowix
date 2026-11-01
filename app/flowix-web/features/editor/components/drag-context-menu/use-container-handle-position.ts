import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { Editor } from '@tiptap/core'
import type { CurrentBlockInfo } from '@features/editor/components/drag-context-menu/block-info'
import {
  computeContainerHandlePosition,
  type HandlePosition,
} from '@features/editor/components/drag-context-menu/positioning'

interface ContainerHandleState {
  visible: boolean
  x: number
  y: number
  blockInfo: CurrentBlockInfo | null
}

const HIDDEN: ContainerHandleState = { visible: false, x: 0, y: 0, blockInfo: null }

function sameBlock(a: CurrentBlockInfo | null, b: CurrentBlockInfo | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.pos === b.pos && a.typeName === b.typeName
}

/**
 * 触屏「父容器抓手」的定位。
 *
 * 与行尾抓手 (行级) 的区别: 这枚抓手对应**整块容器** (分栏 / 列表 / 引用 /
 * callout / 折叠块), 点击出元素菜单、按住拖动整体移动。因此它取的是
 * `resolveContainerBlock` 解析出的本层最外层容器, 而不是当前行。
 *
 * 「本层」的边界是 doc 或 column: 分栏里每一列都是独立单元, 列内 callout
 * 的抓手只作用于该列的 callout, 不会升级成整块 `columns` (否则点左列 callout
 * 的抓手会选中并修改整行)。
 *
 * 只在 `enabled` 为真时计算 (多选态下让位给行尾圆点)。
 */
export function useContainerHandlePosition(
  editor: Editor,
  targetInfoRef: RefObject<CurrentBlockInfo | null>,
  enabled: boolean,
) {
  const [state, setState] = useState<ContainerHandleState>(HIDDEN)
  const frameRef = useRef<number | null>(null)
  const refreshRef = useRef<() => void>(() => {})
  const refresh = useCallback(() => refreshRef.current(), [])

  useEffect(() => {
    if (!editor?.view?.dom || editor.view.isDestroyed) return

    let mounted = true

    const commit = (next: ContainerHandleState) => {
      if (!mounted) return
      setState((prev) => (
        prev.visible === next.visible
        && prev.x === next.x
        && prev.y === next.y
        && sameBlock(prev.blockInfo, next.blockInfo)
          ? prev
          : next
      ))
    }

    const update = () => {
      if (!mounted) return
      if (!enabled) {
        commit(HIDDEN)
        return
      }
      const target = targetInfoRef.current
      if (!target) {
        commit(HIDDEN)
        return
      }
      const pos: HandlePosition | null = computeContainerHandlePosition(editor, target)
      if (!pos) {
        commit(HIDDEN)
        return
      }
      commit({ visible: true, x: pos.x, y: pos.y, blockInfo: pos.blockInfo })
    }

    const schedule = () => {
      if (frameRef.current != null) return
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null
        update()
      })
    }
    refreshRef.current = schedule

    const editorDom = editor.view.dom as HTMLElement
    const scroller = editorDom.closest('.editor-content') as HTMLElement | null
    const scrollTarget = scroller ?? editorDom

    editor.on('transaction', schedule)
    editor.on('update', schedule)
    scrollTarget.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    const observer = new ResizeObserver(schedule)
    observer.observe(scroller ?? editorDom)

    update()

    return () => {
      mounted = false
      refreshRef.current = () => {}
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current)
      frameRef.current = null
      editor.off('transaction', schedule)
      editor.off('update', schedule)
      scrollTarget.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      observer.disconnect()
    }
  }, [editor, enabled, targetInfoRef])

  return { ...state, refresh }
}
