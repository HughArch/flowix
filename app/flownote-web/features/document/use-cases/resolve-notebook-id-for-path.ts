import { canonicalDirectoryPath, canonicalPath } from '@/lib/path';

export type NotebookPath = { id: string; path: string };

export function resolveNotebookIdForPath(
  documentPath: string,
  notebooks: readonly NotebookPath[],
): string | undefined {
  const path = canonicalPath(documentPath);
  let owner: NotebookPath | undefined;
  let ownerRootLength = -1;

  for (const notebook of notebooks) {
    const root = canonicalDirectoryPath(notebook.path);
    const rootPrefix = root === '/' ? root : `${root}/`;
    if (!path.startsWith(rootPrefix) || root.length <= ownerRootLength) continue;
    owner = notebook;
    ownerRootLength = root.length;
  }

  return owner?.id;
}
