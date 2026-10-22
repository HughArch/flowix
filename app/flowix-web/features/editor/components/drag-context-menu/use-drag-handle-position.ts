import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { Editor } from '@tiptap/core'
import type { CurrentBlockInfo } from '@features/editor/components/drag-context-menu/block-info'
import { computeHandlePosition } from '@features/editor/components/drag-context-menu/positioning'

interface DragHandlePositionState {
  visible: boolean
  x: number
  y: number
  blockInfo: CurrentBlockInfo | null
}

interface DragHandlePositionResult extends DragHandlePositionState {
  refresh: () => void
}

const HIDDEN_STATE: DragHandlePositionState = {
  visible: false,
  x: 0,
  y: 0,
  blockInfo: null,
}

function isSameBlock(a: CurrentBlockInfo | null, b: CurrentBlockInfo | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.pos === b.pos && a.typeName === b.typeName && a.attrs.level === b.attrs.level
}

function shouldUpdateState(prev: DragHandlePositionState, next: DragHandlePositionState): boolean {
  return (
    prev.visible !== next.visible ||
    prev.x !== next.x ||
    prev.y !== next.y ||
    !isSameBlock(prev.blockInfo, next.blockInfo)
  )
}

export function useDragHandlePosition(
  editor: Editor,
  fontSize: number,
  lineHeight: number,
  ignoreBlurRef?: RefObject<boolean>,
  keepVisibleRef?: RefObject<boolean>,
  interactionInfoRef?: RefObject<CurrentBlockInfo | null>,
  hoverInfoRef?: RefObject<CurrentBlockInfo | null>,
): DragHandlePositionResult {
  const [state, setState] = useState<DragHandlePositionState>(HIDDEN_STATE)
  const frameRef = useRef<number | null>(null)
  const trailingResizeRef = useRef<number | null>(null)
  const refreshRef = useRef<() => void>(() => {})
  const refresh = useCallback(() => refreshRef.current(), [])

  useEffect(() => {
    // editor 可能被销毁后这条 effect 还触发 (e.g. 切换文档/语言时父组件
    // 先卸载, store 又 dispatch 了一次新引用)。访问 editor.view.dom 会
    // 触发 "editor view is not available"。
    if (!editor?.view?.dom || editor.view.isDestroyed) return

    let mounted = true

    const commitState = (next: DragHandlePositionState) => {
      if (!mounted) return
      setState((prev) => shouldUpdateState(prev, next) ? next : prev)
    }

    const updateDragHandle = () => {
      if (!mounted) return
      const interactionInfo = keepVisibleRef?.current ? interactionInfoRef?.current : null
      // Hovering a block shows its handle even when the editor is unfocused.
      // This is what makes Mod/Shift-click block selection possible without
      // first clicking into the body (which would reset the selection).
      const preferredInfo = interactionInfo ?? hoverInfoRef?.current ?? null
      const pos = computeHandlePosition(
        editor,
        fontSize,
        lineHeight,
        !keepVisibleRef?.current,
        preferredInfo,
      )
      if (!pos || !pos.visible) {
        commitState(HIDDEN_STATE)
        return
      }
      commitState({
        visible: true,
        x: pos.x,
        y: pos.y,
        blockInfo: pos.blockInfo,
      })
    }

    const scheduleUpdate = () => {
      if (frameRef.current != null) return
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null
        updateDragHandle()
      })
    }
    refreshRef.current = scheduleUpdate

    const scheduleTrailingResizeUpdate = () => {
      if (trailingResizeRef.current != null) {
        window.clearTimeout(trailingResizeRef.current)
      }
      trailingResizeRef.current = window.setTimeout(() => {
        trailingResizeRef.current = null
        scheduleUpdate()
      }, 80)
    }

    const editorDom = editor.view.dom as HTMLElement
    if (editor.view.isDestroyed) return
    const scrollContainer = editorDom.closest('.editor-content') as HTMLElement | null
    const scrollTarget = scrollContainer || editorDom
    const resizeTarget = scrollContainer || editorDom

    const handleBlur = () => {
      if (keepVisibleRef?.current) return
      if (ignoreBlurRef?.current) return
      // A nested AgentThreadCard composer causes the outer editor to blur.
      // Recompute after the browser updates activeElement so the positioning
      // layer can resolve the card NodeView instead of hiding the handle.
      scheduleUpdate()
    }
    const handleResize = () => {
      scheduleUpdate()
      scheduleTrailingResizeUpdate()
    }

    editor.on('selectionUpdate', updateDragHandle)
    // Undo/redo changes the document and may restore the same NodeSelection
    // anchor. Tiptap only emits selectionUpdate when the selection itself
    // changes, so listen to update as well to remeasure a restored NodeView.
    editor.on('update', updateDragHandle)
    editor.on('focus', updateDragHandle)
    editor.on('blur', handleBlur)
    editorDom.addEventListener('focusin', scheduleUpdate)
    const handleFocusOut = () => {
      // Moving from the nested composer to the handle itself is an intentional
      // interaction. The handle sets ignoreBlur before the browser moves focus;
      // keep the current card anchor through that hand-off so the menu does
      // not disappear between pointerdown and click.
      if (ignoreBlurRef?.current || keepVisibleRef?.current) return
      scheduleUpdate()
    }
    editorDom.addEventListener('focusout', handleFocusOut)
    scrollTarget.addEventListener('scroll', scheduleUpdate, { passive: true })

    const resizeObserver = new ResizeObserver(handleResize)
    resizeObserver.observe(resizeTarget)
    if (resizeTarget !== editorDom) resizeObserver.observe(editorDom)
    const handleLoadedAsset = (event: Event) => {
      if (event.target instanceof HTMLImageElement || event.target instanceof HTMLVideoElement) {
        scheduleUpdate()
      }
    }
    editorDom.addEventListener('load', handleLoadedAsset, true)
    editorDom.addEventListener('loadedmetadata', handleLoadedAsset, true)
    window.addEventListener('resize', scheduleUpdate)
    void document.fonts?.ready.then(() => {
      if (mounted) scheduleUpdate()
    })
    updateDragHandle()

    return () => {
      mounted = false
      refreshRef.current = () => {}
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current)
      if (trailingResizeRef.current != null) window.clearTimeout(trailingResizeRef.current)
      frameRef.current = null
      trailingResizeRef.current = null
      editor.off('selectionUpdate', updateDragHandle)
      editor.off('update', updateDragHandle)
      editor.off('focus', updateDragHandle)
      editor.off('blur', handleBlur)
      editorDom.removeEventListener('focusin', scheduleUpdate)
      editorDom.removeEventListener('focusout', handleFocusOut)
      scrollTarget.removeEventListener('scroll', scheduleUpdate)
      editorDom.removeEventListener('load', handleLoadedAsset, true)
      editorDom.removeEventListener('loadedmetadata', handleLoadedAsset, true)
      window.removeEventListener('resize', scheduleUpdate)
      resizeObserver.disconnect()
    }
  }, [editor, fontSize, lineHeight, ignoreBlurRef, keepVisibleRef, interactionInfoRef, hoverInfoRef])

  return { ...state, refresh }
}
