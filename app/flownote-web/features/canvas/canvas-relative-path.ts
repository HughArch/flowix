import { canonicalDirectoryPath, canonicalPath } from '@/lib/path';

/**
 * Notebook-relative, `/`-joined path of a board file: the address the version
 * archive is keyed by. `null` when the file sits outside the notebook root.
 */
export function notebookRelativeCanvasPath(filePath: string, notebookRootPath: string): string | null {
  const root = canonicalDirectoryPath(notebookRootPath);
  const prefix = root === '/' ? root : `${root}/`;
  const path = canonicalPath(filePath);
  if (!path.startsWith(prefix)) return null;
  const relative = path.slice(prefix.length);
  return relative.length > 0 ? relative : null;
}
