import { flushAllDocumentSessions } from '../store/document-session-service';
import { listDocumentSessions } from '../store/document-runtime-session';
import { documentCommitDiagnostics } from '../store/document-commit-queue';

export const flushDocumentsForShutdown = flushAllDocumentSessions;
export function documentShutdownDiagnostics() {
  return { sessions: listDocumentSessions().length, ...documentCommitDiagnostics() };
}
