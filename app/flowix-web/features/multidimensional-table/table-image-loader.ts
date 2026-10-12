/** One table session owns the cache and the concurrency limit across appended pages. */
export class TableImageLoader {
  private readonly cache = new Map<string, string | null>();
  private readonly running = new Set<string>();
  private wanted = new Set<string>();

  constructor(
    private readonly read: (path: string) => Promise<string | null>,
    private readonly onChange: () => void,
    private readonly concurrency = 4,
  ) {}

  get(path: string): string | null | undefined {
    return this.cache.get(path);
  }

  setPaths(paths: Iterable<string>): void {
    this.wanted = new Set(paths);
    this.pump();
  }

  private pump(): void {
    for (const path of this.wanted) {
      if (this.running.size >= this.concurrency) break;
      if (this.cache.has(path) || this.running.has(path)) continue;
      this.running.add(path);
      // Native reads cannot be aborted; obsolete queued paths are never started.
      void Promise.resolve().then(() => this.read(path)).catch(() => null).then((value) => {
        this.running.delete(path);
        this.cache.set(path, value);
        if (this.wanted.has(path)) this.onChange();
        this.pump();
      });
    }
  }
}
