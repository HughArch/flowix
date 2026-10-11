import { canonicalDirectoryPath, canonicalPath, joinNotebookMemoPath, notebookRelativeDirectoryPath, parentDirectoryPath } from '@/lib/path';

/** Preferred import locations: active filter folder, library folder, then attachments/. */
export function resolveMediaLibraryAddDirectories(
  filePath: string,
  notebookPath: string,
  pathFilter?: string | null,
): Array<string | null> {
  const notebookRoot = canonicalDirectoryPath(notebookPath);
  const configuredFolder = pathFilter?.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const libraryDirectory = parentDirectoryPath(filePath, notebookRoot);

  const candidates: Array<string | null> = [];
  if (configuredFolder) candidates.push(joinNotebookMemoPath(notebookRoot, configuredFolder));
  if (notebookRelativeDirectoryPath(notebookRoot, libraryDirectory) !== null) {
    candidates.push(libraryDirectory);
  }
  candidates.push(null); // Let the shared saver create/use the notebook's attachments/ directory.
  const seen = new Set<string>();
  return candidates.filter((path) => {
    const key = path === null ? 'attachments' : canonicalPath(path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
