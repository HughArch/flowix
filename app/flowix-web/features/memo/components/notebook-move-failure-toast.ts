import { toast } from '@/lib/toast';
import type { I18nKey, I18nParams } from '@/lib/i18n';

export interface NotebookMoveFailure {
  code: string;
  message?: string;
}

type MoveFailureKind = 'cloud' | 'permission' | 'source' | 'target' | 'duplicate';
type MoveTranslator = (key: I18nKey, params?: I18nParams) => string;

const FAILURE_KIND_BY_CODE: Record<string, MoveFailureKind> = {
  FILE_EXISTS: 'duplicate',
  EEXIST: 'duplicate',
  CLOUD_FILE_NOT_DOWNLOADED: 'cloud',
  ICLOUD_FILE_NOT_DOWNLOADED: 'cloud',
  FILE_PERMISSION_DENIED: 'permission',
  FILE_NOT_FOUND: 'source',
  SOURCE_NOT_REGULAR_FILE: 'source',
  SOURCE_NOT_DIRECTORY: 'source',
  TARGET_NOT_DIRECTORY: 'target',
};

const LEGACY_ERROR_CODES = new Set([
  ...Object.keys(FAILURE_KIND_BY_CODE),
  'IMPORT_FOLDER_TOO_MANY_FILES',
  'IMPORT_FOLDER_TOO_MANY_ENTRIES',
  'IMPORT_FOLDER_TOO_DEEP',
  'IMPORT_FOLDER_TOO_LARGE',
  'IMPORT_FOLDER_CLEANUP_FAILED',
  'IMPORT_FOLDER_SCAN_FAILED',
]);

/** Normalize Tauri's structured errors and legacy string errors in one place. */
export function normalizeNotebookMoveFailure(error: unknown): NotebookMoveFailure {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const value = error as { code?: unknown; message?: unknown };
    if (typeof value.code === 'string') {
      return {
        code: value.code,
        ...(typeof value.message === 'string' ? { message: value.message } : {}),
      };
    }
  }

  const raw = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : String(error);
  const separator = raw.indexOf(': ');
  const prefix = separator < 0 ? raw : raw.slice(0, separator);
  const code = LEGACY_ERROR_CODES.has(prefix) ? prefix : 'UNKNOWN';
  return {
    code,
    ...(separator >= 0 ? { message: raw.slice(separator + 2) } : { message: raw }),
  };
}

function failureKind(failure: NotebookMoveFailure): MoveFailureKind | null {
  return FAILURE_KIND_BY_CODE[failure.code] ?? null;
}

export function showNotebookMoveFailureToasts(
  t: MoveTranslator,
  moved: number,
  failed: number,
  failures: NotebookMoveFailure[],
) {
  const counts: Record<Exclude<MoveFailureKind, 'duplicate'>, number> = {
    cloud: 0,
    permission: 0,
    source: 0,
    target: 0,
  };
  let duplicateCount = 0;
  const unknownFailures: NotebookMoveFailure[] = [];
  for (const failure of failures) {
    const kind = failureKind(failure);
    if (!kind) {
      unknownFailures.push(failure);
    } else if (kind === 'duplicate') {
      duplicateCount += 1;
    } else {
      counts[kind] += 1;
    }
  }

  if (duplicateCount > 0) toast.error(t('memo.fileTree.moveDuplicate'));
  const messageKeys: Record<Exclude<MoveFailureKind, 'duplicate'>, I18nKey> = {
    cloud: 'memo.fileTree.moveCloudFileNotDownloaded',
    permission: 'memo.fileTree.movePermissionDenied',
    source: 'memo.fileTree.moveSourceUnavailable',
    target: 'memo.fileTree.moveTargetUnavailable',
  };
  for (const kind of Object.keys(counts) as Array<keyof typeof counts>) {
    if (counts[kind] > 0) {
      toast.error(t(messageKeys[kind], { moved, failed: counts[kind] }));
    }
  }

  const classifiedCount = duplicateCount + Object.values(counts).reduce((sum, count) => sum + count, 0);
  const unknownCount = Math.max(0, failed - classifiedCount);
  if (unknownCount === 0) return;
  const reason = unknownFailures[0]?.message ?? unknownFailures[0]?.code;
  if (import.meta.env.DEV && reason) {
    toast.error(t('memo.fileTree.movePartialFailedWithReason', { moved, failed: unknownCount, reason }));
  } else {
    toast.error(t('memo.fileTree.movePartialFailed', { moved, failed: unknownCount }));
  }
}
