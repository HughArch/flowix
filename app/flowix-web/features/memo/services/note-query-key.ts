import type { TableAutoCollectCondition } from '@features/multidimensional-table/model';
import type { ColorFilterValue } from '@features/memo/store';

export function getNoteQueryKey(
  notebookId: string | undefined,
  filter: string,
  sort: string,
  tagId: string | null,
  colorFilter: ColorFilterValue,
  pluginId?: string | null,
  customFilterId?: string | null,
  dataCondition?: TableAutoCollectCondition | null,
): string {
  const parts = [
    notebookId ?? '',
    filter,
    sort,
    filter === 'tagged' ? tagId ?? '' : '',
    filter === 'color' ? colorFilter : '',
    pluginId ?? '',
  ];
  if (filter === 'custom') parts.push(customFilterId ?? '');
  if (dataCondition) parts.push(JSON.stringify(dataCondition));
  return parts.join(':');
}
