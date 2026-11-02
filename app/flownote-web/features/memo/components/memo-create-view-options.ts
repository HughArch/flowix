import type { I18nKey } from '@/lib/i18n';
import type { TableViewType } from '@features/multidimensional-table/public/create-api';

export const MEMO_CREATE_VIEW_OPTIONS = [
  { type: 'table', labelKey: 'memo.create.table' },
  { type: 'gallery', labelKey: 'memo.create.newGallery' },
  { type: 'kanban', labelKey: 'memo.create.newKanban' },
  { type: 'calendar', labelKey: 'memo.create.newCalendar' },
] as const satisfies ReadonlyArray<{ type: TableViewType; labelKey: I18nKey }>;
