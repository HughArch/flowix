import { notebookAssets, type NotebookAssetSaveResult } from '@platform/tauri/client';

/** Import external files through the shared saver while preserving notebook-local paths. */
export async function saveMediaFile(
  sourcePath: string,
  notebookId: string,
  targetDirectories: Array<string | null>,
): Promise<NotebookAssetSaveResult> {
  let lastError: unknown;
  for (const targetDirectoryPath of targetDirectories) {
    try {
      const saved = await notebookAssets.saveFromPath(sourcePath, {
        notebookId,
        ...(targetDirectoryPath ? { targetDirectoryPath } : {}),
        reuseNotebookFile: true,
      });
      if (!saved?.path) throw new Error('Media save returned no path');
      return saved;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Media save failed');
}
