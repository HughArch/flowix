import { useCallback, useEffect, useLayoutEffect, useRef, type MutableRefObject, type PointerEvent } from 'react'
import type { Editor } from '@tiptap/core'
import type { Node as PMNode } from 'prosemirror-model'
import {
  getBlockInfoAtCoords,
  getBlockInfoForInteraction,
  type CurrentBlockInfo,
} from '@features/editor/components/drag-context-menu/block-info'
import {
  getBlockSelection,
  setBlockSelection,
  toggleBlockSelection,
} from '@features/editor/extensions/block-selection'

/** window 监听用的是 DOM 原生 PointerEvent, 与 React 同名类型区分开。 */
type DomPointerEvent = globalThis.PointerEvent

/**
 * 触屏上的块选中手势。
 *
 *   - 轻点抓手 / 行尾圆点 / 多选态下的任意一行 → 该行切换选中;
 *   - 长按 (380ms) 后上下滑动 → 从长按那一行开始, 按手指经过的行批量扩选;
 *   - 长按触发前就移动 (想滚页面) → 取消长按, 不选中任何东西。
 *
 * 压力点放在 window 级 pointer 监听上而不是 React 捕获: 多选态下长按的
 * 起点在编辑器正文里 (不在抓手/圆点上), window 监听让"任意区域长按拖动"
 * 与"点圆点"共用同一套按压状态机, 也不依赖 setPointerCapture。
 *
 * 与桌面版 `useBlockDragGesture` 完全分开, 两者对"移动"的解释相反:
 * 桌面移动 = 换位置, 触屏移动 = 扩选。
 */

const LONG_PRESS_MS = 380
/** 长按触发前允许的抖动; 超过就当成滚动意图。 */
const TAP_SLOP_PX = 8

interface MobilePressState {
  pointerId: number
  startX: number
  startY: number
  info: CurrentBlockInfo | null
  /** 长按已触发: 之后的移动都在扩选。 */
  extending: boolean
  moved: boolean
  timer: number | null
  /**
   * 扩选阶段的命中 X。手指在行尾 gutter / 任意正文位置, 统一取内容区
   * 水平中线做块命中, 避开 posAtCoords 在边距里解析不到的死角。
   */
  hitX: number
  /** 扩选锚点 (扁平序列里的块位置), 长按触发时确定。 */
  anchorPos: number
  /**
   * 轻点是否切换选中。
   *
   * 抓手 / 圆点上轻点 = 进多选 (true);
   * 正文行上轻点 = 只唤出行尾抓手、不进多选 (false) —— 长按才进多选,
   * 否则手机上点一下正文就会莫名其妙进入多选态。
   */
  tapToggles: boolean
}

interface UseMobileBlockSelectionOptions {
  editor: Editor
  blockInfo: CurrentBlockInfo | null
  ignoreBlurRef: MutableRefObject<boolean>
  /** 轻点后要保留的抓手目标 (父组件用它维持抓手可见)。 */
  onActivate: (info: CurrentBlockInfo | null) => void
}

type BlockPointerEvent = PointerEvent<HTMLElement>

/**
 * 扩选命中 callout / 列表这类容器块时, 下钻到容器内第一个可圈选行,
 * 与行尾圆点的粒度保持一致 (圆点从来不出现在容器上)。
 */
const CONTAINER_TYPES = new Set(['bulletList', 'orderedList', 'columns', 'column', 'blockquote', 'callout', 'toggle'])

/** 与 `mobile-selection-dots` 的可圈选块集合保持一致。 */
const SELECTABLE_BLOCK_TYPES = new Set([
  'paragraph', 'heading', 'table', 'image', 'videoAttachment', 'fileAttachment',
  'listItem', 'codeBlock', 'mathBlock',
])

const MAX_WALK_DEPTH = 5

/**
 * 按「行尾圆点」的同一套遍历把文档摊平成可圈选块序列。
 *
 * 扩选必须走这条扁平序列, 不能用 `extendBlockSelection`: 后者只在同一
 * 父容器内扩选, 手指一跨容器边界 (callout 内列表项 → 外部段落) 就会把
 * 选区重置成单块, 表现为"下滑完全不生效"。
 */
function collectFlatBlocks(doc: PMNode): { pos: number; nodeSize: number }[] {
  const blocks: { pos: number; nodeSize: number }[] = []
  const walk = (parent: PMNode, contentStart: number, depth: number) => {
    parent.forEach((node, offset) => {
      const pos = contentStart + offset
      if (CONTAINER_TYPES.has(node.type.name)) {
        if (depth < MAX_WALK_DEPTH) walk(node, pos + 1, depth + 1)
        return
      }
      if (!SELECTABLE_BLOCK_TYPES.has(node.type.name)) return
      blocks.push({ pos, nodeSize: node.nodeSize })
    })
  }
  walk(doc, 0, 0)
  return blocks
}

/** 从锚点行到手指所在行, 整段加入块选中 (跨容器连续)。 */
function extendAcrossFlatBlocks(editor: Editor, anchorPos: number, targetPos: number): boolean {
  if (editor.isDestroyed) return false
  const doc = editor.state.doc
  const anchorColumn = columnRangeForPos(doc, anchorPos)
  // 分栏内每一列是独立的选中单元: 锚点在列内时, 扩选范围收在这一列里。
  // 否则下滑到列底会顺着扁平序列跳进右边那一列, 表现为"整行一起被选中"。
  const blocks = collectFlatBlocks(doc).filter((block) => (
    !anchorColumn || (block.pos >= anchorColumn.from && block.pos < anchorColumn.to)
  ))
  const anchorIndex = blocks.findIndex((block) => block.pos === anchorPos)
  const targetIndex = blocks.findIndex((block) => block.pos === targetPos)
  if (anchorIndex < 0 || targetIndex < 0) return false
  const start = Math.min(anchorIndex, targetIndex)
  const end = Math.max(anchorIndex, targetIndex)
  setBlockSelection(
    editor,
    blocks.slice(start, end + 1).map((block) => ({ from: block.pos, to: block.pos + block.nodeSize })),
    anchorPos,
  )
  return true
}

/** 文档位置所在 `column` 节点的位置区间 (不在列内时返回 null)。 */
function columnRangeForPos(doc: PMNode, pos: number): { from: number; to: number } | null {
  let result: { from: number; to: number } | null = null
  doc.descendants((node, nodePos) => {
    if (result) return false
    if (node.type.name !== 'column') return true
    if (pos < nodePos || pos >= nodePos + node.nodeSize) return true
    result = { from: nodePos, to: nodePos + node.nodeSize }
    return false
  })
  return result
}

/** 把文档位置落到扁平序列里最内层的可圈选块 (容器命中时下钻)。 */
function resolveFlatBlockPos(doc: PMNode, pos: number): number | null {
  let best: number | null = null
  for (const block of collectFlatBlocks(doc)) {
    if (pos >= block.pos && pos < block.pos + block.nodeSize) {
      // 序列是深度优先的, 越靠后越内层 → 持续覆盖即取最内层。
      best = block.pos
    }
  }
  return best
}

/**
 * 扩选阶段用于块命中的水平坐标。
 *
 * 普通行取正文水平中线 (避开 posAtCoords 在边距里解析不到的死角)。
 * 分栏内必须取**手指所在那一列**的中线: 若仍用整篇正文的中线, 在左列长按
 * 下滑时命中点会落到右列, 扩选范围被另一列的块截断, 表现为"多列里选不中
 * 这一列的行"。
 */
function resolveHitX(info: CurrentBlockInfo): number {
  const column = info.dom.closest('.flowix-column')
  const rect = (column ?? info.dom).getBoundingClientRect()
  if (rect.width > 0) return rect.left + rect.width / 2
  return rect.left
}


export function useMobileBlockSelection({
  editor,
  blockInfo,
  ignoreBlurRef,
  onActivate,
}: UseMobileBlockSelectionOptions) {
  const pressRef = useRef<MobilePressState | null>(null)

  const clearTimer = useCallback((press: MobilePressState | null) => {
    if (press?.timer != null) {
      window.clearTimeout(press.timer)
      press.timer = null
    }
  }, [])

  /** 扩选阶段的手指 Y → 扁平块序列里的行位置。底部面板覆盖区不选。 */
  const hitTest = useCallback((clientY: number): number | null => {
    const press = pressRef.current
    if (!press || editor.isDestroyed) return null
    const bar = document.querySelector('[data-mobile-selection-bar]')
    if (bar && clientY >= bar.getBoundingClientRect().top) return null
    const coords = editor.view.posAtCoords({ left: press.hitX, top: clientY })
    if (!coords) return null
    return resolveFlatBlockPos(editor.state.doc, coords.pos)
  }, [editor])

  const startPress = useCallback((
    info: CurrentBlockInfo | null,
    clientX: number,
    clientY: number,
    pointerId: number,
    /** 轻点是否切换选中; 正文行上传 false (轻点只唤抓手)。 */
    tapToggles = true,
  ) => {
    if (!info) return
    ignoreBlurRef.current = true
    const press: MobilePressState = {
      pointerId,
      startX: clientX,
      startY: clientY,
      info,
      extending: false,
      moved: false,
      timer: null,
      hitX: 0,
      anchorPos: info.pos,
      tapToggles,
    }
    press.timer = window.setTimeout(() => {
      press.timer = null
      if (pressRef.current !== press) return
      press.extending = true
      press.hitX = resolveHitX(info)
      // 锚点必须落到扁平序列里的行位置: 长按可能命中 callout / 列表这类
      // 容器, 容器本身不在序列中, 直接用它会把扩选判成"找不到锚点"。
      press.anchorPos = resolveFlatBlockPos(editor.state.doc, info.pos) ?? info.pos
      // 长按起点即扩选锚点: 先把这一行选上, 后续移动再往外扩。
      const selection = getBlockSelection(editor.state)
      if (!selection || !selection.ranges.some((range) => range.from === press.anchorPos)) {
        toggleBlockSelection(editor, { pos: press.anchorPos, nodeSize: info.nodeSize })
      }
      onActivate(info)
    }, LONG_PRESS_MS)
    pressRef.current = press
  }, [editor, ignoreBlurRef, onActivate])

  const onPointerDown = useCallback((event: BlockPointerEvent, infoOverride?: CurrentBlockInfo) => {
    if (event.pointerType === 'mouse') return
    // 目标在 contenteditable 之外或处于多选态, 不拦会先起原生文本选择。
    event.preventDefault()
    const info = infoOverride
      ?? getBlockInfoForInteraction(editor, blockInfo)
      ?? getBlockInfoAtCoords(editor, event.clientX, event.clientY)
    if (!info) return
    startPress(info, event.clientX, event.clientY, event.pointerId)
  }, [blockInfo, editor, startPress])

  /** 手指 Y → 扩选到该行 (锚点 → 手指整段)。 */
  const extendTo = useCallback((clientY: number) => {
    const press = pressRef.current
    if (!press?.extending) return
    const overPos = hitTest(clientY)
    if (overPos == null) return
    const selection = getBlockSelection(editor.state)
    if (selection?.ranges.some((range) => range.from === overPos)) return
    // 跨容器连续扩选 (锚点 → 手指所在行整段加入)。
    if (!extendAcrossFlatBlocks(editor, press.anchorPos, overPos)) return
    onActivate(null)
  }, [editor, hitTest, onActivate])

  useEffect(() => {
    const onMove = (event: DomPointerEvent) => {
      const press = pressRef.current
      if (!press || press.pointerId !== event.pointerId) return
      event.preventDefault()

      if (!press.extending) {
        const distance = Math.hypot(event.clientX - press.startX, event.clientY - press.startY)
        if (distance > TAP_SLOP_PX) {
          press.moved = true
          clearTimer(press)
        }
        return
      }

      extendTo(event.clientY)
    }

    /**
     * 长按扩选期间的 touchmove 接管。
     *
     * 编辑器表面本身可滚动, 浏览器会把「长按后拖动」优先解释成滚动手势,
     * 随即发 pointercancel 掐断后续 pointermove ── 表现为扩选永远停在
     * 锚点那一行 (实测 pointercancel: 1, 选中数不再增长)。这里用非
     * passive 监听阻止默认滚动, 拖动才留在手势引擎手里。
     */
    const onTouchMove = (event: TouchEvent) => {
      const press = pressRef.current
      if (!press?.extending) return
      event.preventDefault()
      const touch = event.touches[0]
      if (touch) extendTo(touch.clientY)
    }

    const finishPointer = (event: DomPointerEvent) => {
      const press = pressRef.current
      if (!press || press.pointerId !== event.pointerId) return
      // 扩选中途的 pointercancel 不结束手势: 由 touchend 收尾。
      if (event.type === 'pointercancel' && press.extending) return
      clearTimer(press)
      pressRef.current = null
      ignoreBlurRef.current = false
      // 长按扩选或中途滑动都不再当作"轻点", 否则抬手会把刚选好的行取消掉。
      if (press.extending || press.moved) return
      if (press.info) {
        // 正文行上轻点: 只把抓手停到这一行, 不进多选 (长按才进多选)。
        if (!press.tapToggles) {
          onActivate(press.info)
          return
        }
        toggleBlockSelection(editor, press.info)
        onActivate(press.info)
      }
    }

    /** 扩选结束 (touch 路径; pointer 已被 cancel 时靠这里收尾)。 */
    const onTouchEnd = () => {
      const press = pressRef.current
      if (!press?.extending) return
      clearTimer(press)
      pressRef.current = null
      ignoreBlurRef.current = false
    }

    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', finishPointer)
    window.addEventListener('pointercancel', finishPointer)
    window.addEventListener('touchmove', onTouchMove, { passive: false })
    window.addEventListener('touchend', onTouchEnd)
    window.addEventListener('touchcancel', onTouchEnd)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finishPointer)
      window.removeEventListener('pointercancel', finishPointer)
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('touchend', onTouchEnd)
      window.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [clearTimer, editor, extendTo, hitTest, onActivate])

  useLayoutEffect(() => () => {
    const press = pressRef.current
    if (press) clearTimer(press)
    pressRef.current = null
    ignoreBlurRef.current = false
  }, [clearTimer, ignoreBlurRef])

  return {
    /** React 元素 (抓手 / 圆点) 的按下入口。 */
    onPointerDown,
    /** 多选态下正文任意位置长按的入口 (原生 pointerdown 监听调用)。 */
    startPress,
  }
}
