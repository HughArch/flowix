import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { Editor } from '@tiptap/core'
import type { Node as PMNode } from 'prosemirror-model'
import type { CurrentBlockInfo } from '@features/editor/components/drag-context-menu/block-info'
import { getBlockSelection } from '@features/editor/extensions/block-selection'

/**
 * 行尾小圆点多选层 (参考用户提供的截图样式)。
 *
 * 进入多选模式后 (至少选中一行), 每个顶层块行尾挂一枚圆点:
 *   - 已选 = 实心品牌色, 未选 = 空心灰;
 *   - 点圆点 toggle 该行;
 *   - 长按圆点上下滑动 = 批量扩选 (手势由 `gesture` 提供, 圆点把自己
 *     的块信息通过 `infoOverride` 交给手势)。
 *
 * 圆点是 React 绝对定位元素 (和抓手同一坐标系: `.editor-content` 内容坐标),
 * 不进 contenteditable, 所以不影响光标 / 排版; 只渲染视口 ± 200px 内的行,
 * 长文也不抖。
 */

const VIEWPORT_OVERSCAN_PX = 200
/** 圆点直径, 与 CSS `.mobile-selection-dot` 保持一致。 */
const DOT_SIZE = 18
/** 子级 (嵌套块) 圆点直径, 与 CSS `.mobile-selection-dot.child` 一致。 */
const CHILD_DOT_SIZE = 14
/** 与首行文字的垂直对齐余量 (行盒中心对齐时再补的偏移)。 */
const DOT_Y_FALLBACK = 5
/** 非分栏行: 圆点距滚动容器右缘的净空 (与行尾抓手同一留白带)。 */
const DOT_RIGHT_INSET = 13
/** 分栏内: 圆点距「所在列」右缘的净空 (与 COLUMN_HANDLE_INSET 一致)。 */
const COLUMN_DOT_INSET = 4

interface SelectionDot {
  key: string
  info: CurrentBlockInfo
  y: number
  /** 距滚动容器右缘的距离; 分栏内按所在列的右缘计算。 */
  right: number
  selected: boolean
  /** 嵌套块 (列表项等) = 子级圆点, 比顶层父级圆点小一号。 */
  child: boolean
}

/** 自身出圆点的块。列表项算可圈选块 (一行一点)。 */
const DOT_BLOCK_TYPES = new Set([
  'paragraph', 'heading', 'table', 'image', 'videoAttachment', 'fileAttachment',
  'listItem', 'codeBlock', 'mathBlock',
])

/** 自身不出圆点、下钻到子块的容器 (callout/quote 内的行也要有自己的圆点)。 */
const CONTAINER_DOT_TYPES = new Set([
  'bulletList', 'orderedList', 'columns', 'column', 'blockquote', 'callout', 'toggle',
])

const MAX_WALK_DEPTH = 5

export function MobileSelectionDots({
  editor,
  gesture,
}: {
  editor: Editor
  gesture: {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>, infoOverride?: CurrentBlockInfo) => void
  }
}) {
  const [dots, setDots] = useState<SelectionDot[]>([])

  const recompute = useCallback(() => {
    if (editor.isDestroyed || editor.view.isDestroyed) return
    const view = editor.view
    const editorDom = view.dom as HTMLElement
    const scroller = editorDom.closest('.editor-content') as HTMLElement | null
    if (!scroller) return

    const contentRect = scroller.getBoundingClientRect()
    const scrollTop = scroller.scrollTop
    const visibleTop = scrollTop - VIEWPORT_OVERSCAN_PX
    const visibleBottom = scrollTop + contentRect.height + VIEWPORT_OVERSCAN_PX
    // 底部操作面板已覆盖的区域不再渲染圆点: 一来视觉上不与菜单叠印,
    // 二来那段区域里的行本来就被面板挡着, 点不到。
    const barTopInContent = (() => {
      // 必须用专用属性: role="toolbar" 同时被选区气泡菜单 / 思维导图控件
      // 使用, 用 role 查询会拿到那些元素, 把"面板上沿"算到屏幕中部,
      // 导致该行以下的所有圆点都被当成"面板覆盖区"裁掉。
      const bar = document.querySelector('[data-mobile-selection-bar]')
      if (!bar) return Number.POSITIVE_INFINITY
      return bar.getBoundingClientRect().top - contentRect.top + scrollTop - 8
    })()
    const selected = new Set(getBlockSelection(view.state)?.ranges.map((range) => range.from) ?? [])

    const next: SelectionDot[] = []
    const pushDot = (node: PMNode, pos: number, depth: number) => {
      const dom = view.nodeDOM(pos)
      if (!(dom instanceof HTMLElement)) return
      const nodeRect = dom.getBoundingClientRect()
      if (nodeRect.height === 0) return
      const top = nodeRect.top - contentRect.top + scrollTop
      if (top + nodeRect.height < visibleTop || top > visibleBottom) return
      if (top > barTopInContent) return

      // 圆点对齐首行文字中心; 非文本块 (图/表) 退化为块顶偏移。
      let y = top + DOT_Y_FALLBACK
      if (node.type.name === 'paragraph' || node.type.name === 'heading') {
        try {
          const coords = view.coordsAtPos(pos + 1)
          y = coords.top - contentRect.top + scrollTop
            + Math.max(0, (coords.bottom - coords.top - DOT_SIZE) / 2)
        } catch {
          // 视图销毁竞态: 保留块顶偏移。
        }
      }

      // 分栏内每一列都有自己的行尾: 圆点必须贴「所在列」的右缘, 不能贴
      // 滚动容器右缘 —— 否则左列的行圆点会跑到右列上, 右列的行圆点则
      // 压在 `.flowix-column-remove` (列右上角的 ×) 上, 视觉上像"整行选中"。
      const columnRect = dom.closest('.flowix-column')?.getBoundingClientRect() ?? null
      const dotSize = depth > 0 ? CHILD_DOT_SIZE : DOT_SIZE
      const baseRight = columnRect
        ? Math.max(0, contentRect.right - columnRect.right) + COLUMN_DOT_INSET
        : DOT_RIGHT_INSET
      // 子级圆点小一号, 右移半个差值让它与父级圆点在同一条竖线上居中。
      const right = baseRight + (DOT_SIZE - dotSize) / 2

      next.push({
        key: `${pos}`,
        info: {
          node,
          typeName: node.type.name,
          attrs: node.attrs,
          pos,
          nodeSize: node.nodeSize,
          dom,
        },
        y,
        right,
        selected: selected.has(pos),
        child: depth > 0,
      })
    }

    /**
     * 深度优先枚举可圈选块: 顶层块 = 父级圆点 (大); 列表项等嵌套块 =
     * 子级圆点 (小)。列表 / 分栏容器本身不给圆点, 下钻到可圈选的子块。
     */
    const walk = (parent: PMNode, contentStart: number, depth: number) => {
      parent.forEach((node, offset) => {
        const pos = contentStart + offset
        if (CONTAINER_DOT_TYPES.has(node.type.name)) {
          // `column` 是「列」这一层的边界: 列内的块是该列的顶层行, 圆点用
          // 父级尺寸 (18px), 不能因为整块分栏嵌套在 doc 之下就一律降级成
          // 子级小圆点 —— 否则多列布局里每列的行圆点都比普通行小一号。
          const nextDepth = node.type.name === 'column' ? 0 : depth + 1
          if (nextDepth <= MAX_WALK_DEPTH) walk(node, pos + 1, nextDepth)
          return
        }
        if (!DOT_BLOCK_TYPES.has(node.type.name)) return
        pushDot(node, pos, depth)
      })
    }
    walk(view.state.doc, 0, 0)

    setDots((prev) => (
      prev.length === next.length && prev.every((dot, index) => (
        dot.key === next[index].key
        && dot.y === next[index].y
        && dot.right === next[index].right
        && dot.selected === next[index].selected
      ))
        ? prev
        : next
    ))
  }, [editor])

  const frameRef = useRef<number | null>(null)
  useEffect(() => {
    if (editor?.view?.isDestroyed) return
    const schedule = () => {
      if (frameRef.current != null) return
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null
        recompute()
      })
    }
    schedule()
    editor.on('transaction', schedule)
    const editorDom = editor.view.dom as HTMLElement
    const scroller = editorDom.closest('.editor-content') as HTMLElement | null
    scroller?.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      if (frameRef.current != null) window.cancelAnimationFrame(frameRef.current)
      frameRef.current = null
      editor.off('transaction', schedule)
      scroller?.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
    }
  }, [editor, recompute])

  if (dots.length === 0) return null

  return (
    <div
      className="mobile-selection-dots-layer"
      // 层本身不吃事件, 圆点按钮单独恢复; 超出层 (底部面板区域) 的圆点
      // 被 overflow 裁掉, 点击只会落在底部面板上。
    >
      {dots.map((dot) => (
        <button
          key={dot.key}
          type="button"
          aria-pressed={dot.selected}
          className={`mobile-selection-dot${dot.selected ? ' selected' : ''}${dot.child ? ' child' : ''}`}
          style={{ top: `${dot.y}px`, right: `${dot.right}px` }}
          onPointerDown={(event) => gesture.onPointerDown(event, dot.info)}
        />
      ))}
    </div>
  )
}
