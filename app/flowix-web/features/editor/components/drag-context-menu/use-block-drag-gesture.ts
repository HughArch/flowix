import { useCallback, useLayoutEffect, useRef, useState, type MutableRefObject, type PointerEvent } from 'react'
import type { Editor } from '@tiptap/core'
import {
  getBlockInfoAtCoords,
  getBlockInfoForInteraction,
  type CurrentBlockInfo,
} from '@features/editor/components/drag-context-menu/block-info'
import {
  createBlockDragPreview,
  removeBlockDragPreview,
  updateBlockDragPreview,
  type BlockDragPreview,
} from '@features/editor/components/drag-context-menu/block-drag-preview'
import { pinBlock, unpinBlock } from '@features/editor/components/drag-context-menu/actions'
import {
  cancelBlockDrag,
  dropBlockDragAt,
  startBlockDrag,
  updateBlockDragPosition,
} from '@features/editor/extensions/block-drag'
import {
  clearBlockSelection,
  extendBlockSelection,
  resolveBlockDragTargets,
  toggleBlockSelection,
} from '@features/editor/extensions/block-selection'

type BlockSelectionModifier = 'toggle' | 'extend' | null

interface PointerBlockDragState {
  pointerId: number
  startX: number
  startY: number
  currentX: number
  currentY: number
  anchorRect: DOMRect
  started: boolean
  /** Modifier held on pointerdown; a non-drag release edits the block selection. */
  selectionModifier: BlockSelectionModifier
}

interface UseBlockDragGestureOptions {
  editor: Editor
  blockInfo: CurrentBlockInfo | null
  ignoreBlurRef: MutableRefObject<boolean>
  onDragStart?: () => void
  onTap?: (anchorRect: DOMRect) => void
}

const BLOCK_DRAG_START_THRESHOLD_PX = 4

/**
 * Resolve the block the handle press belongs to.
 *
 * The handle is positioned from `blockInfo`, so the block it visually sits on
 * IS the target. Resolving from pointer coordinates first would misfire on
 * short adjacent rows (the handle's y can fall inside the previous row's
 * rect). Coordinates are only a last-resort fallback when no usable hover
 * target exists.
 */
function resolvePressedBlock(
  editor: Editor,
  event: PointerEvent<HTMLDivElement>,
  blockInfo: CurrentBlockInfo | null,
): CurrentBlockInfo | null {
  const preferred = getBlockInfoForInteraction(editor, blockInfo)
  if (preferred) return preferred
  const pointed = getBlockInfoAtCoords(editor, event.clientX, event.clientY)
  return pointed ? getBlockInfoForInteraction(editor, pointed) : null
}

/**
 * Owns the pointer gesture around the editor's block-drag plugin.
 *
 * The ProseMirror plugin remains the source of truth for the document move;
 * this hook only owns the short-lived pointer lifecycle and schedules hit
 * testing once per animation frame.
 */
export function useBlockDragGesture({
  editor,
  blockInfo,
  ignoreBlurRef,
  onDragStart,
  onTap,
}: UseBlockDragGestureOptions) {
  const [isDragging, setIsDragging] = useState(false)
  const pointerDragRef = useRef<PointerBlockDragState | null>(null)
  const blockInfoRef = useRef<CurrentBlockInfo | null>(null)
  const dragPreviewRef = useRef<BlockDragPreview | null>(null)
  const moveFrameRef = useRef<number | null>(null)
  const clickResetTimerRef = useRef<number | null>(null)
  const didStartDragRef = useRef(false)

  useLayoutEffect(() => {
    document.documentElement.classList.toggle('flowix-block-dragging', isDragging)
    return () => {
      document.documentElement.classList.remove('flowix-block-dragging')
    }
  }, [isDragging])

  const cancelScheduledMove = useCallback(() => {
    if (moveFrameRef.current == null) return
    window.cancelAnimationFrame(moveFrameRef.current)
    moveFrameRef.current = null
  }, [])

  const markDragClickSuppressed = useCallback(() => {
    didStartDragRef.current = true
    if (clickResetTimerRef.current != null) {
      window.clearTimeout(clickResetTimerRef.current)
    }
    clickResetTimerRef.current = window.setTimeout(() => {
      clickResetTimerRef.current = null
      didStartDragRef.current = false
    }, 0)
  }, [])

  const releasePointerCapture = useCallback((target: HTMLElement, pointerId: number) => {
    if (target.hasPointerCapture(pointerId)) {
      target.releasePointerCapture(pointerId)
    }
  }, [])

  const removeDragPreview = useCallback(() => {
    removeBlockDragPreview(dragPreviewRef.current)
    dragPreviewRef.current = null
  }, [])

  const finishDrag = useCallback((event: PointerEvent<HTMLDivElement>, canceled: boolean) => {
    const drag = pointerDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return

    pointerDragRef.current = null
    const didDrag = drag.started
    cancelScheduledMove()
    removeDragPreview()
    setIsDragging(false)

    if (didDrag) {
      if (canceled) {
        cancelBlockDrag(editor)
      } else {
        dropBlockDragAt(editor, event.clientX, event.clientY)
      }
      unpinBlock(editor)
      markDragClickSuppressed()
    }

    // Keep the target through a non-drag pointerup so the following click can
    // open the menu for the same block. A canceled gesture has no click and
    // must not leave a stale target behind.
    if (didDrag || canceled) {
      blockInfoRef.current = null
    }

    ignoreBlurRef.current = false
    releasePointerCapture(event.currentTarget, event.pointerId)

    // The handle is a focusable element outside ProseMirror. After a real
    // drag, focus can remain on the handle, leaving the image NodeSelection
    // visible while the focus-gated drag handle state is hidden. Restore the
    // Tiptap editor focus so undo/redo and the handle stay in sync.
    if (didDrag && !editor.isDestroyed) {
      editor.commands.focus(undefined, { scrollIntoView: false })
    }

    if (!didDrag && !canceled) {
      const info = blockInfoRef.current
      if (drag.selectionModifier === 'toggle' && info) {
        toggleBlockSelection(editor, info)
      } else if (drag.selectionModifier === 'extend' && info) {
        extendBlockSelection(editor, info)
      } else {
        clearBlockSelection(editor)
        onTap?.(drag.anchorRect)
      }
    }
  }, [cancelScheduledMove, editor, ignoreBlurRef, markDragClickSuppressed, onTap, releasePointerCapture, removeDragPreview])

  const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return

    // The handle sits beside the contenteditable editor. Prevent the browser
    // from starting a native text selection before the drag threshold is met.
    event.preventDefault()
    cancelScheduledMove()
    didStartDragRef.current = false
    const interactionBlockInfo = resolvePressedBlock(editor, event, blockInfo)
    blockInfoRef.current = interactionBlockInfo
    ignoreBlurRef.current = true
    pointerDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      currentX: event.clientX,
      currentY: event.clientY,
      // Capture geometry before a nested AgentThreadCard composer can blur
      // the outer editor and temporarily hide the handle.
      anchorRect: event.currentTarget.getBoundingClientRect(),
      started: false,
      selectionModifier: event.ctrlKey || event.metaKey
        ? 'toggle'
        : event.shiftKey ? 'extend' : null,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [blockInfo, cancelScheduledMove, editor, ignoreBlurRef])

  const onPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const drag = pointerDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return

    drag.currentX = event.clientX
    drag.currentY = event.clientY
    // Prevent native text selection while the pointer travels across editor
    // paragraphs. This must happen before the threshold check; waiting until
    // drag.start is too late because the browser may already have selected text.
    event.preventDefault()

    if (!drag.started) {
      const dx = event.clientX - drag.startX
      const dy = event.clientY - drag.startY
      if (Math.hypot(dx, dy) < BLOCK_DRAG_START_THRESHOLD_PX) return

      const sourceBlocks = resolveBlockDragTargets(editor, blockInfoRef.current)
      const started = startBlockDrag(editor, blockInfoRef.current, sourceBlocks)
      if (!started) {
        pointerDragRef.current = null
        blockInfoRef.current = null
        ignoreBlurRef.current = false
        releasePointerCapture(event.currentTarget, event.pointerId)
        return
      }

      drag.started = true
      const previewElements = sourceBlocks
        .map((block) => editor.view.nodeDOM(block.pos))
        .filter((element): element is HTMLElement => element instanceof HTMLElement)
      dragPreviewRef.current = createBlockDragPreview(
        previewElements.length > 0 ? previewElements : blockInfoRef.current?.dom ?? null,
        event.clientX,
        event.clientY,
      )
      setIsDragging(true)
      if (blockInfoRef.current) {
        pinBlock(editor, blockInfoRef.current)
      }
      onDragStart?.()
    }

    if (moveFrameRef.current != null) return

    moveFrameRef.current = window.requestAnimationFrame(() => {
      moveFrameRef.current = null
      const activeDrag = pointerDragRef.current
      if (!activeDrag?.started) return
      updateBlockDragPreview(dragPreviewRef.current, activeDrag.currentX, activeDrag.currentY)
      updateBlockDragPosition(editor, activeDrag.currentX, activeDrag.currentY)
    })
  }, [blockInfo, editor, ignoreBlurRef, onDragStart, releasePointerCapture])

  useLayoutEffect(() => {
    return () => {
      cancelScheduledMove()
      removeDragPreview()
      if (clickResetTimerRef.current != null) {
        window.clearTimeout(clickResetTimerRef.current)
      }

      const drag = pointerDragRef.current
      if (drag?.started) {
        cancelBlockDrag(editor)
        unpinBlock(editor)
      }
      pointerDragRef.current = null
      ignoreBlurRef.current = false
    }
  }, [cancelScheduledMove, editor, ignoreBlurRef, removeDragPreview])

  return {
    isDragging,
    didStartDragRef,
    interactionBlockInfoRef: blockInfoRef,
    onPointerDown,
    onPointerMove,
    onPointerUp: (event: PointerEvent<HTMLDivElement>) => finishDrag(event, false),
    onPointerCancel: (event: PointerEvent<HTMLDivElement>) => finishDrag(event, true),
    onLostPointerCapture: (event: PointerEvent<HTMLDivElement>) => finishDrag(event, true),
  }
}
