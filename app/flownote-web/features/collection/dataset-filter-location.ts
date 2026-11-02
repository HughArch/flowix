import { notebookRelativeDirectoryPath, parentDirectoryPath } from '@/lib/path';
import type { CollectionPlacement } from './model';

/** Folder paths follow the current index location, including filesystem moves. */
export function resolveDatasetFilterForLocation(
  filter: Record<string, unknown> | null,
  placement: CollectionPlacement,
  filePath: string | null,
  notebookPath: string | null,
): Record<string, unknown> | null {
  if (!filter || placement !== 'folder' || !filePath || !notebookPath) return filter;
  const path = notebookRelativeDirectoryPath(notebookPath, parentDirectoryPath(filePath, notebookPath));
  if (path === null) return filter;
  if (Array.isArray(filter.conditions)) return { ...filter, path };
  const relocate = (rule: Record<string, unknown>): Record<string, unknown> => {
    if (rule.field === 'path') return { ...rule, value: path };
    return {
      ...rule,
      ...(Array.isArray(rule.all) ? { all: rule.all.map(relocate) } : {}),
      ...(Array.isArray(rule.any) ? { any: rule.any.map(relocate) } : {}),
    };
  };
  return relocate(filter);
}
