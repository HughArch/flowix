import type { ExternalDocumentSession } from '../store/document-store';
import { documentIdentityFromFile } from '../store/document-identity';
import { captureLatestDocumentContent, discardDocumentDraft, saveDocumentPath, hasDocumentUnsavedChanges } from '../store/document-session-service';
import { expectExternalDocumentDelete } from '../store/external-document-operation';
import { localDocumentOperations } from './local-document-operations';

/** Delete only after every editor sharing this identity has persisted its draft. */
export async function deleteExternalDocument(session: ExternalDocumentSession): Promise<boolean> {
  const identity = documentIdentityFromFile(session.fileIdentity);
  captureLatestDocumentContent(identity);
  const saved = await saveDocumentPath(identity, identity.path, session.scopePath);
  if (!saved || hasDocumentUnsavedChanges(identity)) return false;

  const cancelExpectedDelete = expectExternalDocumentDelete(identity.path);
  try {
    await localDocumentOperations.delete({ path: identity.path, scopePath: session.scopePath });
    discardDocumentDraft(identity);
    return true;
  } catch (error) {
    cancelExpectedDelete();
    throw error;
  }
}
