import { DOMParser } from 'linkedom/worker';

/** Tiptap's HTML parser needs a DOM even when Markdown runs in a Worker. */
export function installMarkdownWorkerDOM(): void {
  if (typeof window !== 'undefined') return;

  class WorkerDOMParser {
    parseFromString(source: string, type: 'text/html') {
      // Tiptap passes a <body> fragment; linkedom requires a document wrapper
      // for Document.body to refer to that body rather than an empty new one.
      return new DOMParser().parseFromString(`<html><head></head>${source}</html>`, type);
    }
  }

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { DOMParser: WorkerDOMParser },
  });
}
