import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { notes, type PathVersionMeta } from '@platform/tauri/client';

const logger = createLogger('canvas-version-history');

interface CanvasVersionHistoryOptions {
  notebookId: string | undefined;
  relativePath: string | null;
  readOnly: boolean;
  /** Persist pending board edits; resolves false when the save failed. */
  flush: () => Promise<boolean>;
  /** Bytes last written to or read from disk: the restore's optimistic guard. */
  lastSavedText: () => string | null;
  /** Re-read the board from disk once a restore has replaced the file. */
  reload: () => void;
}

/**
 * Local version archive for a canvas board, mirroring the note titlebar
 * flow: save first so the archive and the restore guard see the latest bytes,
 * then let the board reload itself from disk instead of patching state.
 */
export function useCanvasVersionHistory({
  notebookId, relativePath, readOnly, flush, lastSavedText, reload,
}: CanvasVersionHistoryOptions) {
  const { t } = useI18n();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [confirmVersion, setConfirmVersion] = useState<PathVersionMeta | null>(null);
  const [restoringVersionId, setRestoringVersionId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const mounted = useRef(false);
  const restoring = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const enabled = !readOnly && !!notebookId && !!relativePath;

  const archiveVersion = useCallback(async () => {
    if (readOnly || !notebookId || !relativePath) return;
    try {
      if (!await flush()) throw new Error('Saving current board failed');
      await notes.createVersion(notebookId, relativePath);
      if (!mounted.current) return;
      setRefreshKey((key) => key + 1);
      toast.success(t('canvas.version.archived'));
    } catch (error) {
      logger.error('archive canvas version failed', { error, relativePath });
      if (mounted.current) toast.error(t('document.version.saveCurrentFailed'));
    }
  }, [flush, notebookId, readOnly, relativePath, t]);

  const restoreVersion = useCallback(async () => {
    if (readOnly || !notebookId || !relativePath || !confirmVersion || restoring.current) return;
    restoring.current = true;
    setRestoringVersionId(confirmVersion.id);
    try {
      if (!await flush()) {
        if (mounted.current) toast.error(t('document.version.saveCurrentFailed'));
        return;
      }
      if (!mounted.current) return;
      const content = await notes.restoreVersion(
        notebookId, relativePath, confirmVersion.id, lastSavedText() ?? undefined,
      );
      if (content === null) throw new Error('Version restore was refused');
      reload();
      if (mounted.current) {
        setConfirmVersion(null);
        setRefreshKey((key) => key + 1);
        toast.success(t('document.version.restored'));
      }
    } catch (error) {
      logger.error('restore canvas version failed', { error, relativePath });
      if (mounted.current) toast.error(t('document.version.restoreFailed'));
    } finally {
      restoring.current = false;
      if (mounted.current) setRestoringVersionId(null);
    }
  }, [confirmVersion, flush, lastSavedText, notebookId, readOnly, relativePath, reload, t]);

  return {
    enabled,
    historyOpen, setHistoryOpen,
    confirmVersion, setConfirmVersion,
    restoringVersionId, refreshKey,
    archiveVersion, restoreVersion,
  };
}
