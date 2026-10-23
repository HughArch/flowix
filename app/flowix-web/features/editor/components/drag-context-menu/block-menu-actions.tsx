import { useMemo, type ReactNode } from 'react'
import { ArrowLeftIcon, ArrowRightIcon, ColumnsIcon, RowsIcon, TrashSimpleIcon } from '@phosphor-icons/react'
import {
  headingMenuItems,
  listMenuItems,
  blockMenuItems,
  imageMenuItems,
  type BlockMenuItem,
} from '@features/editor/components/drag-context-menu/items'
import type { ImageAlignment } from '@features/editor/components/drag-context-menu/items'
import type { CurrentBlockInfo } from '@features/editor/components/drag-context-menu/block-info'
import { useI18n } from '@/lib/i18n'

export type BlockMenuActionGroup = 'heading' | 'list' | 'block' | 'layout' | 'image' | 'table' | 'mode' | 'danger'

export interface BlockMenuAction {
  id: string
  group: BlockMenuActionGroup
  icon: ReactNode
  label: string
  trailingIcon?: ReactNode
  checked?: boolean
  shortcut?: string
  /** Renders the row inert: skipped by keyboard navigation and not activatable. */
  disabled?: boolean
  /** Tooltip explaining why the row is disabled. */
  disabledReason?: string
  onSelect: () => void
  /**
   * Nested actions revealed on hover / ArrowRight.
   *
   * A parent row may still carry its own `onSelect`: the menu treats the row as
   * a disclosure *and* an action, so activating it runs `onSelect` while the
   * hover/ArrowRight affordance opens the panel. Leave `onSelect` a no-op only
   * when the parent is a pure heading.
   */
  children?: BlockMenuAction[]
  /** Optional non-interactive heading rendered above `children`. */
  childrenGroupLabel?: string
}

export interface TableHeaderState {
  rowHeader: boolean
  columnHeader: boolean
}

/** Column commands exposed by the drag-handle menu. */
export interface ColumnMenuState {
  /** The target block already lives inside a column. */
  inColumn: boolean
  /** A top-level block can become a columns container. */
  canSplit: boolean
  /** The current column group still has room for another column. */
  canInsertColumn: boolean
  canDeleteColumn: boolean
  onInsertColumn: (side: 'left' | 'right') => void
  onSplitInto: (count: 2 | 3 | 4 | 5) => void
  onDeleteColumn: () => void
}

/** Keep the menu state aligned with FlowixTable's Markdown header semantics. */
export function getTableHeaderState(node: CurrentBlockInfo['node'] | undefined): TableHeaderState {
  if (!node || node.type.name !== 'table' || node.childCount === 0) {
    return { rowHeader: false, columnHeader: false }
  }

  const firstRow = node.firstChild
  if (!firstRow || firstRow.type.name !== 'tableRow' || firstRow.childCount === 0) {
    return { rowHeader: false, columnHeader: false }
  }

  const rows = Array.from({ length: node.childCount }, (_, index) => node.child(index))
  const columnHeader = firstRow.childCount > 1
    && rows.length > 1
    && rows.every((row) => row.type.name === 'tableRow' && row.firstChild?.type.name === 'tableHeader')
  const rowHeader = Array.from({ length: firstRow.childCount }, (_, index) => firstRow.child(index))
    .some((cell, index) => cell.type.name === 'tableHeader' && (index > 0 || !columnHeader))

  return { rowHeader, columnHeader }
}

export function useBlockMenuActions(
  onMenuItem: (item: BlockMenuItem) => void,
  onDelete: () => void,
  blockTypeName?: string,
  onImageAlign?: (alignment: ImageAlignment) => void,
  tableHeaderState?: TableHeaderState,
  onTableHeaderToggle?: (header: 'row' | 'column') => void,
  columnMenu?: ColumnMenuState,
): BlockMenuAction[] {
  const { t } = useI18n()
  return useMemo(() => {
    if (blockTypeName === 'image' || blockTypeName === 'videoAttachment') {
      return [
        ...imageMenuItems.map((item): BlockMenuAction => ({
          id: `image-align-${item.alignment}`,
          group: 'image',
          icon: item.icon,
          label: t(item.displayKey),
          onSelect: () => onImageAlign?.(item.alignment),
        })),
        {
          id: 'delete',
          group: 'danger',
          icon: <TrashSimpleIcon size={16} weight="bold" />,
          label: t('editor.block.delete'),
          onSelect: onDelete,
        },
      ]
    }

    if (blockTypeName === 'table') {
      return [
        {
          id: 'table-header-row',
          group: 'table',
          icon: <RowsIcon size={16} weight="bold" />,
          label: t('editor.table.headerRow'),
          checked: tableHeaderState?.rowHeader ?? false,
          onSelect: () => onTableHeaderToggle?.('row'),
        },
        {
          id: 'table-header-column',
          group: 'table',
          icon: <ColumnsIcon size={16} weight="bold" />,
          label: t('editor.table.headerColumn'),
          checked: tableHeaderState?.columnHeader ?? false,
          onSelect: () => onTableHeaderToggle?.('column'),
        },
        {
          id: 'delete',
          group: 'danger',
          icon: <TrashSimpleIcon size={16} weight="bold" />,
          label: t('editor.block.delete'),
          onSelect: onDelete,
        },
      ]
    }

    const columnActions: BlockMenuAction[] = columnMenu
      ? [
          {
            id: 'insert-column-left',
            group: 'layout',
            icon: <ArrowLeftIcon size={16} weight="bold" />,
            label: t('editor.block.insertColumnLeft'),
            disabled: !columnMenu.canInsertColumn,
            onSelect: () => columnMenu.onInsertColumn('left'),
          },
          {
            id: 'insert-column-right',
            group: 'layout',
            icon: <ArrowRightIcon size={16} weight="bold" />,
            label: t('editor.block.insertColumnRight'),
            disabled: !columnMenu.canInsertColumn,
            onSelect: () => columnMenu.onInsertColumn('right'),
          },
          ...([2, 3, 4, 5] as const).map((count): BlockMenuAction => ({
            id: `columns-${count}`,
            group: 'layout',
            icon: <ColumnsIcon size={16} weight="bold" />,
            label: t(
              count === 2 ? 'editor.block.columns2'
                : count === 3 ? 'editor.block.columns3'
                  : count === 4 ? 'editor.block.columns4'
                    : 'editor.block.columns5',
            ),
            disabled: !columnMenu.canSplit,
            onSelect: () => columnMenu.onSplitInto(count),
          })),
          ...(columnMenu.canDeleteColumn
            ? [{
                id: 'delete-column',
                group: 'danger' as const,
                icon: <TrashSimpleIcon size={16} weight="bold" />,
                label: t('editor.block.removeColumn'),
                onSelect: columnMenu.onDeleteColumn,
              }]
            : []),
        ]
      : []

    const actions: BlockMenuAction[] = [
      ...headingMenuItems.map((item): BlockMenuAction => ({
        id: item.kind === 'heading' ? `h${item.level}` : 'paragraph',
        group: 'heading',
        icon: item.icon,
        label: item.kind === 'paragraph' ? t('editor.block.paragraph') : item.display,
        shortcut: item.shortcut,
        onSelect: () => onMenuItem(item),
      })),
      ...listMenuItems.map((item): BlockMenuAction => ({
        id: item.listType,
        group: 'list',
        icon: item.icon,
        label: t(
          item.listType === 'bulletList'
            ? 'editor.block.bulletList'
            : item.listType === 'orderedList'
              ? 'editor.block.orderedList'
              : 'editor.block.taskList',
        ),
        shortcut: item.shortcut,
        onSelect: () => onMenuItem(item),
      })),
      ...blockMenuItems.map((item): BlockMenuAction => ({
        id: item.blockType,
        group: 'block',
        icon: item.icon,
        label: t(item.displayKey),
        onSelect: () => onMenuItem(item),
      })),
      ...columnActions,
      {
        id: 'delete',
        group: 'danger',
        icon: <TrashSimpleIcon size={16} weight="bold" />,
        label: t('editor.block.delete'),
        onSelect: onDelete,
      },
    ]

    return blockTypeName === 'agentThreadCard'
      ? actions.filter((action) => action.id === 'delete')
      : actions
  }, [
    blockTypeName,
    onMenuItem,
    onDelete,
    onImageAlign,
    onTableHeaderToggle,
    columnMenu,
    tableHeaderState,
    t,
  ])
}
