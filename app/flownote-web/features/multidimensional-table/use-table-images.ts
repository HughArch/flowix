import { useEffect, useMemo, useReducer } from 'react';
import { files } from '@platform/tauri/client';
import { joinNotebookMemoPath } from '@/lib/path';
import { TableImageLoader } from './table-image-loader';

export interface TableImageReference { key: string; path: string }

export function useTableImages(references: TableImageReference[], notebookPath: string | null, generation: number) {
  const [revision, refresh] = useReducer((value: number) => value + 1, 0);
  // Reloading a table or changing notebooks starts a fresh cache.
  const loader = useMemo(() => new TableImageLoader(
    (path) => files.readImage(path, notebookPath ?? undefined), refresh,
  ), [notebookPath, generation]);
  const resolved = useMemo(() => references.map(({ key, path }) => ({
    key, path: notebookPath ? joinNotebookMemoPath(notebookPath, path) : path,
  })), [references, notebookPath]);

  useEffect(() => {
    loader.setPaths(resolved.flatMap(({ path }) => path ? [path] : []));
    return () => loader.setPaths([]);
  }, [loader, resolved]);

  return useMemo(() => Object.fromEntries(resolved.map(({ key, path }) => [
    key, path ? loader.get(path) ?? null : null,
  ])), [loader, resolved, revision]);
}
