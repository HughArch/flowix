import type { I18nKey } from '@/lib/i18n';
import { normalizeNotebookMoveFailure } from './notebook-move-failure-toast';

/** Keep folder-import error handling consistent across notebook and repository trees. */
export function getNotebookFolderImportErrorKey(error: unknown): I18nKey {
  const { code } = normalizeNotebookMoveFailure(error);
  switch (code) {
    case 'IMPORT_FOLDER_TOO_MANY_FILES':
      return 'memo.fileTree.importFolderTooManyFiles';
    case 'IMPORT_FOLDER_TOO_MANY_ENTRIES':
      return 'memo.fileTree.importFolderTooManyEntries';
    case 'IMPORT_FOLDER_TOO_DEEP':
      return 'memo.fileTree.importFolderTooDeep';
    case 'IMPORT_FOLDER_TOO_LARGE':
      return 'memo.fileTree.importFolderTooLarge';
    case 'FILE_EXISTS':
      return 'memo.fileTree.importFolderExists';
    case 'FILE_PERMISSION_DENIED':
      return 'memo.fileTree.movePermissionDenied';
    case 'CLOUD_FILE_NOT_DOWNLOADED':
      return 'memo.fileTree.moveCloudFileNotDownloaded';
    case 'IMPORT_FOLDER_CLEANUP_FAILED':
      return 'memo.fileTree.importFolderCleanupFailed';
    default:
      return 'memo.fileTree.importFolderFailed';
  }
}
