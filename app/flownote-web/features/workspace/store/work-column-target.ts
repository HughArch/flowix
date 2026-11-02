import type {
  CollectionSurfaceTarget, WorkspaceContentTarget,
} from '../model/surface-target';
export type CollectionWorkspaceTarget = CollectionSurfaceTarget;

/** Stored Work targets require the transaction ID which is optional at the public boundary. */
export type WorkColumnTarget = Exclude<WorkspaceContentTarget, { kind: 'external' }>
  | (Extract<WorkspaceContentTarget, { kind: 'external' }> & { transitionId: number | null });

/** Local file path for the last successfully committed workColumn target. */
export function workColumnTargetFilePath(target: WorkColumnTarget): string | null {
  switch (target.kind) {
    case 'external':
      return target.path;
    case 'media':
      return target.filePath;
    case 'collection':
    case 'table':
      return target.filePath;
    case 'media-library':
      return target.filePath;
    default:
      return null;
  }
}

export const EMPTY_WORK_COLUMN_TARGET = { kind: 'empty' } as const satisfies WorkColumnTarget;

export type WorkColumnNavigationPhase = 'idle' | 'loading' | 'committed' | 'failed';

export interface WorkColumnNavigationFailure {
  code: 'navigation-failed' | 'navigation-stale';
  message: string;
  requestId: number;
  retryToken: string | null;
}

export interface WorkColumnNavigationState {
  /** The last successfully committed workColumn target. */
  phase: WorkColumnNavigationPhase;
  /** Whether an in-flight transaction should visually block the workColumn. */
  showWorkColumnLoading: boolean;
  requestId: number;
  target: WorkColumnTarget;
  /** The target currently being attempted, if any. */
  pendingTarget: WorkColumnTarget | null;
  /** Target that was active when the current request began. */
  previousTarget: WorkColumnTarget | null;
  failure: WorkColumnNavigationFailure | null;
  retryToken: string | null;
}
