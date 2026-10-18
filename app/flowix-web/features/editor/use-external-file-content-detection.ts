import { useEffect, useState } from 'react';

import { externalDocuments } from '@platform/tauri/client/memos';

type ContentDetection = { filePath: string; scopePath: string | null; isTextContent: boolean };

/** Inspect unknown local files to decide whether the text editor can open them. */
export function useExternalFileContentDetection(filePath: string | null, scopePath: string | null, shouldResolve: boolean) {
  const [detection, setDetection] = useState<ContentDetection | null>(null);

  useEffect(() => {
    if (!filePath || !shouldResolve) return;
    let cancelled = false;
    void externalDocuments.detectTextContent(filePath, scopePath).then((isTextContent) => {
      if (!cancelled) setDetection({ filePath, scopePath, isTextContent });
    }).catch(() => {
      if (!cancelled) setDetection({ filePath, scopePath, isTextContent: false });
    });
    return () => { cancelled = true; };
  }, [filePath, scopePath, shouldResolve]);

  const current = detection?.filePath === filePath && detection.scopePath === scopePath ? detection : null;
  return {
    isTextContent: current?.isTextContent ?? false,
    loading: Boolean(filePath && shouldResolve && !current),
  };
}
