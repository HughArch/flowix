import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ArrowsClockwiseIcon,
  CaretLeftIcon,
  ChecksIcon,
  ClipboardTextIcon,
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

  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      className="fixed inset-0 z-[160] flex items-end bg-black/30"
      role="presentation"
      onClick={onClose}
    >
      <div
        role="menu"
        data-mobile-swipe-ignore=""
        aria-label={title}
        className="w-full rounded-t-2xl border-t border-[var(--border-popup)] bg-[var(--card)] pb-[env(safe-area-inset-bottom)] shadow-[0_-4px_24px_-3px_rgb(0_0_0_/_0.24)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 justify-center pt-2">
          <span aria-hidden="true" className="h-1 w-9 rounded-full bg-[var(--border)]" />
        </div>
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
  onSelectAll: () => void
  onCopy: () => void
  onCut: () => void
  onPaste: () => void
  onDelete: () => void
  /** 「转换为」: 仅单选 (块类型转换对多行无意义)。 */
  onMore: () => void
  /** 「着色」: 行背景 + 文字颜色。 */
  onColor: () => void
  onInsertAbove: () => void
  onInsertBelow: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  onDone: () => void
}

/**
 * 选中若干行后的底部操作面板 (图标网格, 同截图样式):
 * 剪切 / 复制 / 粘贴 / 全选 / 删除 常驻; 「转换为」仅单选出现
 * (块类型转换对多行无意义)。遮罩是透明的 ── 正文保持原样不变灰,
 * 点面板外任意处 = 完成并退出多选。
 */
export function MobileBlockSelectionBar({
  count,
  showMore,
  actions,
}: {
  count: number
  /** 单选时展示「转换为」入口; 多选隐藏。 */
  showMore: boolean
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
  }, [count, showMore])

  if (count <= 0 || typeof document === 'undefined') return null

  const iconProps = { size: 22, weight: 'bold' as const }

  return (
    <div
      ref={cardRef}
      className="fixed inset-x-0 bottom-0 z-[155] rounded-t-2xl border-t border-[var(--border-popup)] bg-[var(--card)] pb-[env(safe-area-inset-bottom)] shadow-[0_-4px_24px_-3px_rgb(0_0_0_/_0.24)]"
      role="toolbar"
      data-mobile-swipe-ignore=""
      aria-label={t('editor.block.selectionCount', { count })}
    >
      <div>
        <div className="flex justify-center pt-2">
          <span aria-hidden="true" className="h-1 w-9 rounded-full bg-[var(--border)]" />
        </div>
        <div className="flex items-center justify-between px-3 pt-1">
          <span className="text-xs text-[var(--muted-foreground)]">
            {t('editor.block.selectionCount', { count })}
          </span>
          <button
            type="button"
            onClick={actions.onDone}
            className="rounded-lg px-2 py-1 text-xs text-[var(--brand)]"
          >
            {t('editor.block.done')}
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
          <button type="button" className={GRID_TILE_CLASS} onClick={actions.onSelectAll}>
            <ChecksIcon {...iconProps} />
            <span>{t('editor.block.selectAllBlocks')}</span>
          </button>
          {showMore && (
            <button type="button" className={GRID_TILE_CLASS} onClick={actions.onMore}>
              <ArrowsClockwiseIcon {...iconProps} />
              <span>{t('editor.block.convertTo')}</span>
            </button>
          )}
          {showMore && (
            <button type="button" className={GRID_TILE_CLASS} onClick={actions.onColor}>
              <PaletteIcon {...iconProps} />
              <span>{t('editor.block.coloring')}</span>
            </button>
          )}
          {showMore && (
            <button type="button" className={GRID_TILE_CLASS} onClick={actions.onInsertAbove}>
              <RowsPlusTopIcon {...iconProps} />
              <span>{t('editor.block.insertAbove')}</span>
            </button>
          )}
          {showMore && (
            <button type="button" className={GRID_TILE_CLASS} onClick={actions.onInsertBelow}>
              <RowsPlusBottomIcon {...iconProps} />
              <span>{t('editor.block.insertBelow')}</span>
            </button>
          )}
          {showMore && (
            <button type="button" className={GRID_TILE_CLASS} onClick={actions.onMoveUp}>
              <ArrowUpIcon {...iconProps} />
              <span>{t('editor.block.moveUp')}</span>
            </button>
          )}
          {showMore && (
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
