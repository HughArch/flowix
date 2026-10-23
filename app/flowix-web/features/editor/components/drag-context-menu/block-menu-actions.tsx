import { useMemo, type CSSProperties, type ReactNode } from 'react'
import { ArrowLeftIcon, ArrowRightIcon, CheckIcon, ColumnsIcon, HighlighterIcon, RowsIcon, TrashSimpleIcon } from '@phosphor-icons/react'
import {
  headingMenuItems,
  listMenuItems,
  blockMenuItems,
  imageMenuItems,
  type BlockMenuItem,
} from '@features/editor/components/drag-context-menu/items'
import type { ImageAlignment } from '@features/editor/components/drag-context-menu/items'
import type { CurrentBlockInfo } from '@features/editor/components/drag-context-menu/block-info'
import type { I18nKey } from '@/lib/i18n'
import { useI18n } from '@/lib/i18n'
import { FLOWIX_TEXT_COLORS, type FlowixTextColor } from '@features/editor/extensions/flowix-text-mark'

export type BlockMenuActionGroup = 'heading' | 'list' | 'block' | 'layout' | 'background' | 'image' | 'table' | 'mode' | 'danger'

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

/**
 * Line background state for the drag-handle menu.
 *
 * `current` is the colour shared by every targeted block, or `null` when the
 * targets disagree (or none is set). The command itself fans out across the
 * whole block selection, so the menu only has to describe the shared state.
 */
export interface BlockBackgroundMenuState {
  current: FlowixTextColor | null
  onChange: (color: FlowixTextColor | null) => void
}

const flowixColorLabelKeys: Record<FlowixTextColor, I18nKey> = {
  red: 'editor.highlight.red',
  orange: 'editor.highlight.orange',
  yellow: 'editor.highlight.yellow',
  green: 'editor.highlight.green',
  cyan: 'editor.highlight.cyan',
  blue: 'editor.highlight.blue',
  purple: 'editor.highlight.purple',
  pink: 'editor.highlight.pink',
  gray: 'editor.highlight.gray',
}

function ColorSwatch({ color }: { color: FlowixTextColor | null }) {
  return (
    <span
      aria-hidden="true"
      className={`block-menu-color-swatch${color ? '' : ' block-menu-color-swatch--default'}`}
      style={color ? { '--block-menu-swatch': `var(--flowix-text-${color})` } as CSSProperties : undefined}
    />
  )
}

/** Flowus-style column-count preview: N vertical bars in the row's leading icon. */
function ColumnCountIcon({ count }: { count: 2 | 3 | 4 | 5 }) {
  return (
    <span
      aria-hidden="true"
      className="block-menu-column-preview"
      style={{ gridTemplateColumns: `repeat(${count}, 1fr)` }}
    >
      {Array.from({ length: count }, (_, index) => (
        <span key={index} />
      ))}
    </span>
  )
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
  blockBackground?: BlockBackgroundMenuState,
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

    // One disclosure row keeps the menu compact: the column-count choices and
    // the insert/delete commands live in the submenu instead of six top-level
    // rows. Hovering or ArrowRight opens it; clicking runs the row's default
    // action (split into two, or add a column on the right).
    const columnSubActions: BlockMenuAction[] = columnMenu
      ? [
          ...(columnMenu.canSplit
            ? ([2, 3, 4, 5] as const).map((count): BlockMenuAction => ({
                id: `columns-${count}`,
                group: 'layout',
                icon: <ColumnCountIcon count={count} />,
                label: t(
                  count === 2 ? 'editor.block.columns2'
                    : count === 3 ? 'editor.block.columns3'
                      : count === 4 ? 'editor.block.columns4'
                        : 'editor.block.columns5',
                ),
                onSelect: () => columnMenu.onSplitInto(count),
              }))
            : []),
          ...(columnMenu.inColumn
            ? [
                {
                  id: 'insert-column-left',
                  group: 'layout' as const,
                  icon: <ArrowLeftIcon size={16} weight="bold" />,
                  label: t('editor.block.insertColumnLeft'),
                  disabled: !columnMenu.canInsertColumn,
                  onSelect: () => columnMenu.onInsertColumn('left'),
                },
                {
                  id: 'insert-column-right',
                  group: 'layout' as const,
                  icon: <ArrowRightIcon size={16} weight="bold" />,
                  label: t('editor.block.insertColumnRight'),
                  disabled: !columnMenu.canInsertColumn,
                  onSelect: () => columnMenu.onInsertColumn('right'),
                },
              ]
            : []),
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

    const columnActions: BlockMenuAction[] = columnMenu && columnSubActions.length > 0
      ? [{
          id: 'columns',
          group: 'layout',
          icon: <ColumnsIcon size={16} weight="bold" />,
          label: t('editor.block.columns'),
          childrenGroupLabel: t('editor.block.columns'),
          onSelect: () => {
            if (columnMenu.canSplit) {
              columnMenu.onSplitInto(2)
              return
            }
            if (columnMenu.canInsertColumn) columnMenu.onInsertColumn('right')
          },
          children: columnSubActions,
        }]
      : []

    const backgroundActions: BlockMenuAction[] = blockBackground
      ? [
          {
            id: 'block-background',
            group: 'background',
            icon: <HighlighterIcon size={16} weight="bold" />,
            label: t('editor.block.background'),
            childrenGroupLabel: t('editor.block.background'),
            // Disclosure row: the panel is opened through hover / ArrowRight,
            // and picking a swatch applies the colour across every selected row.
            onSelect: () => {},
            children: [
              {
                id: 'block-background-default',
                group: 'background',
                icon: <ColorSwatch color={null} />,
                label: t('editor.block.backgroundDefault'),
                checked: blockBackground.current === null,
                trailingIcon: <CheckIcon size={12} weight="bold" />,
                onSelect: () => blockBackground.onChange(null),
              },
              ...FLOWIX_TEXT_COLORS.map((color): BlockMenuAction => ({
                id: `block-background-${color}`,
                group: 'background',
                icon: <ColorSwatch color={color} />,
                label: t(flowixColorLabelKeys[color]),
                checked: blockBackground.current === color,
                trailingIcon: <CheckIcon size={12} weight="bold" />,
                onSelect: () => blockBackground.onChange(color),
              })),
            ],
          },
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
      ...backgroundActions,
      {
        id: 'delete',
        group: 'danger',
        icon: <TrashSimpleIcon size={16} weight="bold" />,
        label: t('editor.block.delete'),
        onSelect: onDelete,
      },
    ]

    if (blockTypeName === 'agentThreadCard') {
      return actions.filter((action) => action.id === 'delete')
    }
    if (blockTypeName === 'callout') {
      // The handle targets the whole container, so text-block conversions do
      // not apply. Keep deletion and the column operations (splitting a callout
      // into columns stays valid).
      return actions.filter((action) => action.group === 'danger' || action.group === 'layout')
    }
    return actions
  }, [
    blockTypeName,
    onMenuItem,
    onDelete,
    onImageAlign,
    onTableHeaderToggle,
    columnMenu,
    blockBackground,
    tableHeaderState,
    t,
  ])
}
