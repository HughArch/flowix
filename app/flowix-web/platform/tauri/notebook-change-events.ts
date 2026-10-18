import { subscribe, type SubscribeOptions, type UnlistenFn } from './event-bus';
import { createLogger } from '@/lib/logger';

/** Compatibility payload. Only this boundary interprets the legacy optional fields. */
interface PathNoteChangedPayload {
  changeId?: string;
  notebookId: string;
  relativePath?: string;
  previousRelativePath?: string;
  created?: boolean;
  directory?: boolean;
  deleted?: boolean;
  source?: 'external_tool';
  originWindowLabel?: string;
}

export type NotebookPathMove = {
  changeId: string;
  notebookId: string;
  previousRelativePath: string;
  relativePath: string;
  directory: boolean;
};

export type NotebookPathCreated = {
  changeId?: string;
  notebookId: string;
  relativePath: string;
  source?: 'external_tool';
  originWindowLabel?: string;
};

export interface PathMutationResult {
  path: string;
  notebookChange?: NotebookPathMove | null;
}

export type NotebookChange = (
  | { kind: 'path-moved'; notebookId: string; relativePath: string; previousRelativePath: string; directory: boolean }
  | { kind: 'resource-created'; notebookId: string; relativePath: string; source?: 'external_tool'; originWindowLabel?: string }
  | { kind: 'resource-deleted'; notebookId: string; relativePath: string }
  | { kind: 'query-invalidated'; notebookId: string; relativePath: string | null }
) & { changeId?: string };

const localHandlers = new Set<(change: NotebookChange) => void>();
const logger = createLogger('notebook-change');

/** Command receipts use the same subscription and dedup boundary as broadcasts. */
export function publishNotebookQueryInvalidated(notebookId: string): void {
  for (const handler of [...localHandlers]) {
    try { handler({ kind: 'query-invalidated', notebookId, relativePath: null }); }
    catch (error) { logger.warn('apply notebook refresh failed', { error, notebookId }); }
  }
}

export function publishNotebookPathMove(change: NotebookPathMove | null | undefined): void {
  if (!change) return;
  for (const handler of [...localHandlers]) {
    try { handler({ ...change, kind: 'path-moved' }); }
    catch (error) { logger.warn('apply command path move failed', { error, changeId: change.changeId }); }
  }
}

export function publishNotebookPathCreated(change: NotebookPathCreated | null | undefined): void {
  if (!change) return;
  for (const handler of [...localHandlers]) {
    try { handler({ ...change, kind: 'resource-created' }); }
    catch (error) { logger.warn('apply command path create failed', { error, changeId: change.changeId }); }
  }
}

export function acceptPathMutationResult(result: string | PathMutationResult): string {
  // Frontend HMR can precede the Rust process restart during development.
  if (typeof result === 'string') return result;
  if (result.notebookChange) publishNotebookPathMove(result.notebookChange);
  return result.path;
}

/** A path notification without a confirmed move/delete is only an invalidation,
 * not evidence that document content changed. Empty paths invalidate the notebook.
 */
export function normalizeNotebookChange(payload: PathNoteChangedPayload): NotebookChange {
  const { notebookId, relativePath, previousRelativePath } = payload;
  if (relativePath && payload.created) {
    return {
      kind: 'resource-created', notebookId, relativePath, source: payload.source,
      originWindowLabel: payload.originWindowLabel, changeId: payload.changeId,
    };
  }
  if (relativePath && payload.deleted) {
    return { kind: 'resource-deleted', notebookId, relativePath, changeId: payload.changeId };
  }
  if (relativePath && previousRelativePath && relativePath !== previousRelativePath) {
    return {
      kind: 'path-moved', notebookId, relativePath, previousRelativePath, changeId: payload.changeId,
      directory: payload.directory === true,
    };
  }
  return { kind: 'query-invalidated', notebookId, relativePath: relativePath || null };
}

export function subscribeNotebookChanges(
  handler: (change: NotebookChange) => void,
  options?: SubscribeOptions,
): UnlistenFn {
  // Per-consumer tracking: one consumer must not suppress delivery to another.
  // Bound memory; path application must remain safe even after an ID is evicted.
  const seen = new Set<string>();
  const deliver = (change: NotebookChange) => {
    if (change.changeId && seen.has(change.changeId)) return;
    handler(change);
    if (change.changeId) {
      seen.add(change.changeId);
      if (seen.size > 512) seen.delete(seen.values().next().value!);
    }
  };
  localHandlers.add(deliver);
  const stop = subscribe<PathNoteChangedPayload>('flowix:path-note-changed', (payload) => {
    deliver(normalizeNotebookChange(payload));
  }, options);
  return () => { localHandlers.delete(deliver); stop(); };
}
