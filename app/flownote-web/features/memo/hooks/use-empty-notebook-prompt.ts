import { useEffect, useRef } from 'react';

/** The first-run wizard owns notebook creation until its boot check and setup finish. */
export function useEmptyNotebookPrompt({
  startupReady,
  hasSelectedNotebook,
  suppressed,
  openCreate,
}: {
  startupReady: boolean;
  hasSelectedNotebook: boolean;
  suppressed: boolean;
  openCreate: () => void;
}) {
  const prompted = useRef(false);

  useEffect(() => {
    if (!startupReady || suppressed) return;
    if (hasSelectedNotebook) {
      prompted.current = false;
      return;
    }
    if (prompted.current) return;
    prompted.current = true;
    openCreate();
  }, [hasSelectedNotebook, openCreate, startupReady, suppressed]);
}
