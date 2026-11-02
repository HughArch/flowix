/** Wait for the full save transaction, including work performed after its write. */
export function createSaveBarrier() {
  let failed = false;
  let pending: { promise: Promise<boolean>; resolve: (saved: boolean) => void } | null = null;
  return {
    setSaving(saving: boolean) {
      if (saving) {
        if (pending) return;
        failed = false;
        let resolve!: (saved: boolean) => void;
        const promise = new Promise<boolean>((done) => { resolve = done; });
        pending = { promise, resolve };
      } else {
        const completed = pending;
        pending = null;
        completed?.resolve(!failed);
      }
    },
    fail() { failed = true; },
    resetFailure() { failed = false; },
    cancel() {
      const cancelled = pending;
      pending = null;
      cancelled?.resolve(false);
    },
    async flush(): Promise<boolean> {
      while (pending) {
        if (!await pending.promise) return false;
      }
      return !failed;
    },
  };
}
