import { sanitizeFileName } from '@/lib/export-utils';
import { createUniqueNotebookFile } from '@features/collection/create-unique-notebook-file';
import { CANVAS_FILE_EXTENSION, createCanvasDocumentText } from './model';

export async function createCanvasFile(
  notebookPath: string,
  relativeFolder: string | null | undefined,
  name: string,
): Promise<{ filePath: string; relativePath: string; name: string }> {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error('请输入画布名称');

  const fileStem = sanitizeFileName(trimmedName).replace(/\.flowix-canvas$/i, '');
  if (!fileStem) throw new Error('画布名称无效');

  const { filePath, relativePath } = await createUniqueNotebookFile(
    notebookPath,
    relativeFolder,
    fileStem,
    `.${CANVAS_FILE_EXTENSION}`,
    createCanvasDocumentText(),
  );
  return { filePath, relativePath, name: fileStem };
}
