import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import type { TableView } from './model';
import { NOTE_CREATED_AT_FIELD_ID, NOTE_PATH_FIELD_ID, NOTE_UPDATED_AT_FIELD_ID } from './builtin-fields';

export type TableSortDirection = 'asc' | 'desc' | null;

function canonicalSortField(field: string): string {
  if (field === 'modified_at') return NOTE_UPDATED_AT_FIELD_ID;
  if (field === 'created_at') return NOTE_CREATED_AT_FIELD_ID;
  if (field === 'path') return NOTE_PATH_FIELD_ID;
  return field;
}

export function tableSortDirection(sort: TableView['sort'], fieldId: string): TableSortDirection {
  return sort.find((item) => canonicalSortField(item.field) === fieldId)?.direction ?? null;
}

/** Column buttons select one sort field; clearing returns to dataset order. */
export function cycleTableSort(sort: TableView['sort'], fieldId: string): TableView['sort'] {
  const direction = tableSortDirection(sort, fieldId);
  return direction === 'desc' ? [] : [{ field: fieldId, direction: direction === 'asc' ? 'desc' : 'asc' }];
}

export function TableSortButton({ label, direction, disabled, onClick }: {
  label: string;
  direction: TableSortDirection;
  disabled: boolean;
  onClick: () => void;
}) {
  const Icon = direction === 'asc' ? ArrowUp : direction === 'desc' ? ArrowDown : ArrowUpDown;
  const state = direction === 'asc' ? '升序' : direction === 'desc' ? '降序' : '未排序';
  const next = direction === 'asc' ? '降序' : direction === 'desc' ? '取消排序' : '升序';
  return <button type="button" aria-label={`${label}：${state}，点击${next}`} title={`${state}，点击${next}`} aria-pressed={direction !== null} disabled={disabled}
    className={`mr-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed ${direction ? 'text-[var(--brand)] disabled:text-[var(--muted-foreground)]' : 'text-[var(--muted-foreground)] opacity-0 group-hover/table-column:opacity-100 focus-visible:opacity-100'}`}
    onClick={(event) => { event.stopPropagation(); onClick(); }}>
    <Icon className="h-3.5 w-3.5" aria-hidden="true" />
  </button>;
}
