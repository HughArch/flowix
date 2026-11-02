import {
  captureLatestDocumentContent,
  hasDocumentUnsavedChanges,
  protectDocumentDraft,
  reconcileUnsavedExternalDocumentChange,
  scheduleDocumentSessionSave,
} from '../../store/document-session-service';
import { useEffect } from 'react';

import { documentIdentityKey, type DocumentIdentity } from '@features/document/store/document-identity';
import { translate } from '@/lib/i18n';
import { getCurrentAppLanguage } from '@features/preferences/public/runtime-api';
import { toast } from '@/lib/toast';
import { canonicalPath } from '@/lib/path';
import { createLogger } from '@/lib/logger';
import { findFileDisplayPath } from '@/lib/file-display-registry';
import { subscribeExternalDocumentChanges } from '@features/document/store/external-document-watch';

const logger = createLogger('external-document-change-watch');

interface UseExternalDocumentChangeWatchOptions {
  filePath: string;
  identity: DocumentIdentity;
  scopePath: string | null;
  clearSaveTimer: () => void;
  reloadDocument: (path: string, options?: { preservePending?: boolean; showLoading?: boolean }) => Promise<void>;
}

export function useExternalDocumentChangeWatch({
  filePath,
  identity,
  scopePath,
  clearSaveTimer,
  reloadDocument,
}: UseExternalDocumentChangeWatchOptions) {
  useEffect(() => {
    if (!filePath) return;

    let disposed = false;
    const currentPath = canonicalPath(filePath);
    const stillWatchingCurrentPath = () => !disposed
      && canonicalPath(findFileDisplayPath(identity.displayId) ?? filePath) === currentPath;

    const identityKey = documentIdentityKey(identity);
    const unsubscribe = subscribeExternalDocumentChanges(filePath, scopePath, async (payload, context) => {
      if (disposed || !stillWatchingCurrentPath() || canonicalPath(payload.path) !== currentPath) {
        logger.info('external change ignored by handler', {
          path: payload.path,
          disposed,
          watchingCurrent: stillWatchingCurrentPath(),
        });
        return;
      }
      logger.info('external change accepted by handler', { path: payload.path, kind: payload.kind });
      captureLatestDocumentContent(identity);
      if (payload.kind === 'deleted') {
        await context.runOnce('missing-warning', () => {
          const language = getCurrentAppLanguage();
          toast.warning(translate(language, 'document.external.changeWarning'), { duration: 5000 });
        });
        clearSaveTimer();
        const protectedDraft = await context.runOnce(`protect-draft:${identityKey}`, () =>
          protectDocumentDraft(identity, filePath, 'autosave').catch(() => false));
        if (!protectedDraft) {
          await context.runOnce(`schedule-save:${identityKey}`, () => scheduleDocumentSessionSave(identity));
          return;
        }
        if (stillWatchingCurrentPath()) {
          // Refresh the actual path state so the surface can offer retry
          // and index cleanup. A missing file must not leave a stale editor
          // looking ready after an external deletion.
          await reloadDocument(filePath, { preservePending: true, showLoading: false });
        }
        return;
      }
      if (hasDocumentUnsavedChanges(identity)) {
        // The write boundary performs the shared diffy merge under the
        // cross-process file lock. A real overlap surfaces the conflict UI.
        await context.runOnce(`reconcile:${identityKey}`, () =>
          reconcileUnsavedExternalDocumentChange(identity, filePath, scopePath));
        return;
      }
      clearSaveTimer();
      await reloadDocument(filePath, { preservePending: false, showLoading: false });
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [filePath, identity, scopePath, clearSaveTimer, reloadDocument]);
}
