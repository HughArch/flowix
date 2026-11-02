import { collectionNotebookId, mutateCollectionFile } from '@features/collection/mutations';
import { parseMediaLibrary } from './model';

export async function renameMediaLibrary({ notebookPath, notebookId, collectionId, title, onRenamed }: {
  notebookPath: string;
  notebookId?: string | null;
  collectionId: string;
  title: string;
  onRenamed?: (nextPath: string) => void;
}) {
  const result = await mutateCollectionFile({ notebookId: await collectionNotebookId(notebookPath, notebookId),
    notebookPath, collectionId, newName: title });
  onRenamed?.(result.filePath);
  return { ...result, document: parseMediaLibrary(result.content) };
}
