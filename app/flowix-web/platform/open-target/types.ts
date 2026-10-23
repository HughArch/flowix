export interface ExternalDocumentOpenRequest {
  filePaths: string[];
  source?: 'open' | 'drop' | 'picker';
  destination?: 'main-third' | 'browser-column';
}

export const FLOWIX_EXTERNAL_DOCUMENT_OPEN_EVENT = 'flowix:external-document-open';

export function requestExternalDocumentOpen(request: ExternalDocumentOpenRequest): void {
  if (!request.filePaths.length) return;
  window.dispatchEvent(new CustomEvent<ExternalDocumentOpenRequest>(FLOWIX_EXTERNAL_DOCUMENT_OPEN_EVENT, {
    detail: request,
  }));
}
