export const HISTORY_READ_TIMEOUT_MS = 30_000;

export class HistoryReadTimeoutError extends Error {
  constructor() {
    super("History read timed out");
    this.name = "HistoryReadTimeoutError";
  }
}

/** Bound result adoption: a late IPC response cannot resume the caller. */
export async function readHistoryWithTimeout<T>(read: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new HistoryReadTimeoutError()), HISTORY_READ_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
