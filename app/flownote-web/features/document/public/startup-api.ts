import { useDocumentStore } from '@features/document/store/document-store';

/** Wait for the restored document's content load to finish before disk maintenance starts. */
export function waitForInitialDocumentLoad(timeoutMs = 60_000): Promise<'settled' | 'unavailable' | 'skipped' | 'timeout'> {
  const initial = useDocumentStore.getState();
  if (!initial.isDocumentTransitioning) {
    if (!initial.activeExternalSession) return Promise.resolve('skipped');
    return Promise.resolve(initial.documentLoadOutcome === 'unavailable' ? 'unavailable' : 'settled');
  }
  return new Promise((resolve) => {
    let finished = false;
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout>;
    const finish = (result: 'settled' | 'unavailable' | 'skipped' | 'timeout') => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(result);
    };
    unsubscribe = useDocumentStore.subscribe((state) => {
      // A user action can replace the restored target while it is loading.
      // Wait for the latest transition to settle before releasing startup.
      if (!state.isDocumentTransitioning) {
        finish(!state.activeExternalSession ? 'skipped'
          : state.documentLoadOutcome === 'unavailable' ? 'unavailable' : 'settled');
      }
    });
    timer = setTimeout(() => finish('timeout'), timeoutMs);
    // The transition may finish between the first snapshot and subscribe().
    const current = useDocumentStore.getState();
    if (!current.isDocumentTransitioning) {
      finish(!current.activeExternalSession ? 'skipped'
        : current.documentLoadOutcome === 'unavailable' ? 'unavailable' : 'settled');
    }
  });
}
