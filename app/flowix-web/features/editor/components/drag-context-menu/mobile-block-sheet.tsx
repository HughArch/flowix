import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ArrowsClockwiseIcon,
  CaretLeftIcon,
  ChecksIcon,
  ClipboardTextIcon,
  ColumnsIcon,
  CopyIcon,
  PaletteIcon,
  RowsPlusBottomIcon,
  RowsPlusTopIcon,
  ScissorsIcon,
  TrashSimpleIcon,
} from '@phosphor-icons/react'
import type { BlockMenuAction } from '@features/editor/components/drag-context-menu/block-menu-actions'
import { useI18n } from '@/lib/i18n'

/** 弹层条目: `sectionLabel` 非空时渲染为分组小标题 (着色面板用)。 */
export type MobileSheetAction = BlockMenuAction & { sectionLabel?: string }

/**
 * 移动端块菜单 —— 底部弹出, 图标网格 (参考用户提供的截图样式)。
 *
 * 样式契约: 白底圆角卡片 + 顶部 grabber, 操作以「图标在上、文字在下」的
 * 5 列网格铺开, 破坏性操作 (删除) 用红色; 没有桌面的 hover 子菜单, 带子级
 * 的项点击后整页下钻 (返回键回上级)。
 */

const GRID_TILE_CLASS = 'flex flex-col items-center justify-start gap-1 rounded-xl px-1 py-2 text-[11px] leading-tight text-[var(--foreground)] transition-colors active:bg-[var(--hover-bg)] disabled:cursor-default disabled:opacity-40'

/** 顶部横条向下拖动关闭的阈值 (px)。 */
const GRABBER_DISMISS_PX = 40

/**
 * 顶部横条 (grabber) 的「向下拖动即关闭」手势。
 *
 * 与弹层/面板的其它区域隔离: 只在横条自己的 pointer 事件上生效, 不干扰
 * 面板内的网格点按; 拖动超过阈值立即触发 `onDismiss`, 未达阈值回弹。
 */
function useGrabberDismiss(onDismiss: () => void) {
  const [dragOffset, setDragOffset] = useState(0)
  const startYRef = useRef<number | null>(null)

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // 鼠标同样支持 (桌面浏览器窄窗口 / 平板接鼠标)。
    event.currentTarget.setPointerCapture?.(event.pointerId)
    startYRef.current = event.clientY
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (startYRef.current == null) return
    setDragOffset(Math.max(0, event.clientY - startYRef.current))
  }

  const finish = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (startYRef.current == null) return
    const distance = Math.max(0, event.clientY - startYRef.current)
    startYRef.current = null
    setDragOffset(0)
    if (distance >= GRABBER_DISMISS_PX) onDismiss()
  }

  return {
    dragOffset,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: finish,
      onPointerCancel: finish,
    },
  }
}

function Grabber({ onDismiss }: { onDismiss: () => void }) {
  const { dragOffset, handlers } = useGrabberDismiss(onDismiss)
  return (
    <div
      className="flex shrink-0 cursor-grab touch-none justify-center pt-2 active:cursor-grabbing"
      // 拖动时给横条一点跟手位移, 松手回弹 (或达阈值直接关闭)。
      style={{ transform: dragOffset > 0 ? `translateY(${Math.min(dragOffset, 24)}px)` : undefined }}
      {...handlers}
    >
      <span aria-hidden="true" className="h-1 w-9 rounded-full bg-[var(--border)]" />
    </div>
  )
}

function SheetShell({
  title,
  onClose,
  header,
  children,
}: {
  title?: string
  onClose: () => void
  header: ReactNode
  children: ReactNode
}) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  // 遮罩的"点外部关闭"必须由**在遮罩上按下**发起。
  //
  // 触屏点抓手时 `openMenu` 会同步 setState, 遮罩在 touchend 之后立即挂载;
  // 浏览器随后为同一次触摸补发的 click 会直接命中这层遮罩 (抓手已被盖住),
  // 于是弹层刚打开就被自己关掉 —— 表现为"点抓手毫无反应"。记下按下起点即可
  // 把这种"补发的穿透 click"与用户真正的点空白区分开。
  const backdropPressRef = useRef(false)

  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      className="fixed inset-0 z-[160] flex items-end bg-black/30"
      role="presentation"
      onPointerDown={(event) => {
        backdropPressRef.current = event.target === event.currentTarget
      }}
      onClick={(event) => {
        const startedOnBackdrop = backdropPressRef.current
        backdropPressRef.current = false
        if (!startedOnBackdrop || event.target !== event.currentTarget) return
        onClose()
      }}
    >
      <div
        role="menu"
        // 专用标识: 多选态的"点外部取消"用它在 DOM 上判定"点在弹层里",
        // 不再靠 role="toolbar" / 文案匹配 (会和选区气泡菜单等撞车)。
        data-mobile-sheet=""
        data-mobile-swipe-ignore=""
        aria-label={title}
        className="w-full rounded-t-2xl border-t border-[var(--border-popup)] bg-[var(--card)] pb-[env(safe-area-inset-bottom)] shadow-[0_-4px_24px_-3px_rgb(0_0_0_/_0.24)]"
        onClick={(event) => event.stopPropagation()}
      >
        <Grabber onDismiss={onClose} />
        {header}
        {children}
      </div>
    </div>,
    document.body,
  )
}

function ActionTile({
  sectionLabel,
  icon,
  label,
  checked,
  disabled,
  showCaret,
  onClick,
}: {
  sectionLabel?: string
  icon: ReactNode
  label: string
  checked?: boolean
  disabled?: boolean
  showCaret?: boolean
  onClick: () => void
}) {
  // 分组小标题 (如 着色面板的「行背景」「文字颜色」): 占满整行的非交互头。
  if (sectionLabel) {
    return (
      <div className="col-span-5 px-1 pb-0.5 pt-2 text-xs font-medium text-[var(--muted-foreground)]">
        {sectionLabel}
      </div>
    )
  }

  return (
    <button
      type="button"
      role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => {
        if (!disabled) onClick()
      }}
      className={GRID_TILE_CLASS}
    >
      <span className={`flex h-6 items-center justify-center${checked ? ' text-[var(--brand)]' : ''}`}>
        {icon}
      </span>
      <span className={`max-w-full truncate${checked ? ' text-[var(--brand)]' : ''}`}>
        {label}
        {showCaret && <span aria-hidden="true" className="ml-0.5 text-[9px] text-[var(--muted-foreground)]">›</span>}
      </span>
    </button>
  )
}

export function MobileBlockSheet({
  open,
  title,
  actions,
  onClose,
}: {
  open: boolean
  title?: string
  actions: MobileSheetAction[]
  onClose: () => void
}) {
  const { t } = useI18n()
  // 下钻页: 带子级的网格项点击后整页切换到子级网格, 左上角返回。
  const [drillIndex, setDrillIndex] = useState<number | null>(null)

  useEffect(() => {
    if (!open) setDrillIndex(null)
  }, [open])

  if (!open) return null

  const parent = drillIndex != null ? actions[drillIndex] : null
  const tiles: MobileSheetAction[] = parent ? (parent.children ?? []) : actions
  const header = (
    <div className="flex w-full items-center justify-between px-3 pb-1 pt-1">
      {parent ? (
        <button
          type="button"
          className="flex items-center gap-0.5 rounded-lg py-1 pr-2 text-sm text-[var(--brand)]"
          onClick={() => setDrillIndex(null)}
        >
          <CaretLeftIcon size={14} weight="bold" />
          {t('editor.block.back')}
        </button>
      ) : <span />}
      <span className="min-w-0 truncate text-sm font-medium text-[var(--foreground)]">
        {parent ? parent.childrenGroupLabel ?? parent.label : title ?? t('editor.block.convertTo')}
      </span>
      <button
        type="button"
        onClick={onClose}
        className="shrink-0 rounded-lg px-2 py-1 text-sm text-[var(--brand)]"
      >
        {t('editor.block.done')}
      </button>
    </div>
  )

  return (
    <SheetShell title={title} onClose={onClose} header={header}>
      <div className="grid grid-cols-5 gap-y-1 px-2 pb-3 pt-1">
        {tiles.map((action) => (
          <ActionTile
            key={action.id}
            sectionLabel={action.sectionLabel}
            icon={action.icon}
            label={action.label}
            checked={action.checked}
            disabled={action.disabled}
            showCaret={(action.children?.length ?? 0) > 0}
            onClick={() => {
              if ((action.children?.length ?? 0) > 0) {
                setDrillIndex(actions.indexOf(action))
                return
              }
              action.onSelect()
            }}
          />
        ))}
      </div>
    </SheetShell>
  )
}

export interface MobileBlockSelectionActions {
  /** 全选 / 取消全选 (由 `allSelected` 决定当前语义)。 */
  onToggleSelectAll: () => void
  onCopy: () => void
  onCut: () => void
  onPaste: () => void
  onDelete: () => void
  /** 「转换为」: 单选与多选都提供 (多选时对每一行分别转换)。 */
  onMore: () => void
  /** 「着色」: 行背景 + 文字颜色, 单选与多选都提供。 */
  onColor: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  /** 以下仅单选: 相对"某一行"插入才有确定语义。 */
  onInsertAbove: () => void
  onInsertBelow: () => void
  /** 「插入分栏」: 只在选中行右侧加一列。 */
  onInsertColumn: () => void
  /** 取消多选 (面板右上角按钮 / 顶部横条下拉)。 */
  onCancel: () => void
}

/**
 * 选中若干行后的底部操作面板 (图标网格, 同截图样式)。
 *
 *   - 常驻: 剪切 / 复制 / 粘贴 / 全选(⇄取消全选) / 转换为 / 着色 / 删除
 *   - 仅单选: 上方插入行 / 下方插入行 / 插入分栏 / 上移 / 下移
 *
 * 「转换为」「着色」在多选下同样可用 (按行逐块生效); 插入类操作必须有
 * 确定的参照行, 所以只留给单选。遮罩是透明的 ── 正文保持原样不变灰,
 * 点面板外任意处 = 取消并退出多选。
 */
export function MobileBlockSelectionBar({
  count,
  single,
  allSelected,
  actions,
}: {
  count: number
  /** 单选 (count === 1): 展示"相对某一行"的操作。 */
  single: boolean
  /** 已全选: 「全选」按钮翻转为「取消全选」。 */
  allSelected: boolean
  actions: MobileBlockSelectionActions
}) {
  const { t } = useI18n()
  const cardRef = useRef<HTMLDivElement | null>(null)

  // 把面板实际高度写给圆点层 (CSS 变量), 圆点层 overflow 裁剪用。
  useLayoutEffect(() => {
    const measure = () => {
      const height = cardRef.current?.offsetHeight ?? 0
      document.documentElement.style.setProperty('--mobile-selection-bar-height', `${height}px`)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('resize', measure)
      document.documentElement.style.setProperty('--mobile-selection-bar-height', '0px')
    }
  }, [count, single, allSelected])

  if (count <= 0 || typeof document === 'undefined') return null

  const iconProps = { size: 22, weight: 'bold' as const }

  return (
    <div
      ref={cardRef}
      className="fixed inset-x-0 bottom-0 z-[155] rounded-t-2xl border-t border-[var(--border-popup)] bg-[var(--card)] pb-[env(safe-area-inset-bottom)] shadow-[0_-4px_24px_-3px_rgb(0_0_0_/_0.24)]"
      // 用专用 data 属性而不是 role="toolbar": 选区气泡菜单 / 思维导图控件
      // 也用 role="toolbar", 靠 role 查询会拿到它们, 圆点层据此算裁剪区
      // 就会算错 (多选时下方圆点全部消失)。
      data-mobile-selection-bar=""
      role="toolbar"
      data-mobile-swipe-ignore=""
      aria-label={t('editor.block.selectionCount', { count })}
    >
      <div>
        <Grabber onDismiss={actions.onCancel} />
        <div className="flex items-center justify-between px-3 pt-1">
          <span className="text-xs text-[var(--muted-foreground)]">
            {t('editor.block.selectionCount', { count })}
          </span>
          <button
            type="button"
            onClick={actions.onCancel}
            className="rounded-lg px-2 py-1 text-xs text-[var(--brand)]"
          >
            {t('editor.block.cancel')}
          </button>
        </div>
        <div className="grid grid-cols-5 gap-y-1 px-2 pb-2 pt-1">
          <button type="button" className={GRID_TILE_CLASS} onClick={actions.onCut}>
            <ScissorsIcon {...iconProps} />
            <span>{t('editor.block.cut')}</span>
          </button>
          <button type="button" className={GRID_TILE_CLASS} onClick={actions.onCopy}>
            <CopyIcon {...iconProps} />
            <span>{t('editor.block.copy')}</span>
          </button>
          <button type="button" className={GRID_TILE_CLASS} onClick={actions.onPaste}>
            <ClipboardTextIcon {...iconProps} />
            <span>{t('editor.block.paste')}</span>
          </button>
          <button type="button" className={GRID_TILE_CLASS} onClick={actions.onToggleSelectAll}>
            <ChecksIcon {...iconProps} />
            <span>
              {allSelected ? t('editor.block.deselectAllBlocks') : t('editor.block.selectAllBlocks')}
            </span>
          </button>
          <button type="button" className={GRID_TILE_CLASS} onClick={actions.onMore}>
            <ArrowsClockwiseIcon {...iconProps} />
            <span>{t('editor.block.convertTo')}</span>
          </button>
          <button type="button" className={GRID_TILE_CLASS} onClick={actions.onColor}>
            <PaletteIcon {...iconProps} />
            <span>{t('editor.block.coloring')}</span>
          </button>
          {single && (
            <button type="button" className={GRID_TILE_CLASS} onClick={actions.onInsertAbove}>
              <RowsPlusTopIcon {...iconProps} />
              <span>{t('editor.block.insertAbove')}</span>
            </button>
          )}
          {single && (
            <button type="button" className={GRID_TILE_CLASS} onClick={actions.onInsertBelow}>
              <RowsPlusBottomIcon {...iconProps} />
              <span>{t('editor.block.insertBelow')}</span>
            </button>
          )}
          {single && (
            <button type="button" className={GRID_TILE_CLASS} onClick={actions.onInsertColumn}>
              <ColumnsIcon {...iconProps} />
              <span>{t('editor.block.insertColumn')}</span>
            </button>
          )}
          {single && (
            <button type="button" className={GRID_TILE_CLASS} onClick={actions.onMoveUp}>
              <ArrowUpIcon {...iconProps} />
              <span>{t('editor.block.moveUp')}</span>
            </button>
          )}
          {single && (
            <button type="button" className={GRID_TILE_CLASS} onClick={actions.onMoveDown}>
              <ArrowDownIcon {...iconProps} />
              <span>{t('editor.block.moveDown')}</span>
            </button>
          )}
          <button
            type="button"
            className={`${GRID_TILE_CLASS} !text-[var(--destructive)]`}
            onClick={actions.onDelete}
          >
            <TrashSimpleIcon {...iconProps} />
            <span>{t('editor.block.delete')}</span>
          </button>
        </div>
      </div>
    </div>
  )
}
