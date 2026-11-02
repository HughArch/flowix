import { canonicalDirectoryPath } from './path';

interface CollectionSessionIdentity {
  expectedCollectionId?: string | null;
  notebookId: string | null;
  notebookPath: string | null;
  filePath: string;
  fileIdentity?: { displayId: string };
}

/** Views share a collection session and display identity; only presentation state changes. */
export function collectionSessionKey(identity: CollectionSessionIdentity): string {
  if (identity.notebookId && identity.expectedCollectionId) {
    return JSON.stringify(['collection', identity.notebookId, identity.expectedCollectionId]);
  }
  return identity.fileIdentity?.displayId ?? JSON.stringify([
    identity.filePath,
    identity.notebookPath ? canonicalDirectoryPath(identity.notebookPath) : null,
    identity.notebookId,
  ]);
}
