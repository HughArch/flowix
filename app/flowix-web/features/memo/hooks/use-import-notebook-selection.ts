import { useCallback, useEffect, useState } from 'react';

/** Default once per batch; retain an explicit choice while that notebook exists. */
export function useImportNotebookSelection(
  requestId: number | undefined,
  notebooks: readonly { id: string }[],
  currentNotebookId: string | undefined,
) {
  const [selection, setSelection] = useState<{ requestId: number | undefined; notebookId: string }>({
    requestId: undefined, notebookId: '',
  });

  useEffect(() => {
    setSelection((previous) => {
      if (previous.requestId === requestId && notebooks.some(({ id }) => id === previous.notebookId)) {
        return previous;
      }
      const notebookId = requestId === undefined ? ''
        : notebooks.find(({ id }) => id === currentNotebookId)?.id ?? notebooks[0]?.id ?? '';
      return { requestId, notebookId };
    });
  }, [requestId, notebooks, currentNotebookId]);

  const selectNotebook = useCallback((notebookId: string) => {
    setSelection({ requestId, notebookId });
  }, [requestId]);

  return [selection.notebookId, selectNotebook] as const;
}
