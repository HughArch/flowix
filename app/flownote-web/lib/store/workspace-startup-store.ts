import type { StartupStatus } from '@platform/tauri/client/general';
import { create } from 'zustand';

export type WorkspaceStartupStatus = 'idle' | 'running' | 'ready' | 'degraded' | 'failed';
export type NativeStartupPhase = 'pending' | 'running' | 'ready' | 'failed';

/** Process-local foreground startup state. Never persist it across launches. */
export const useWorkspaceStartupStore = create<{
  nativePhase: NativeStartupPhase;
  nativeStage: 'initialization' | 'workspacePreparation';
  nativeStep: string;
  nativeError: string | null;
  nativeProgress: { percent: number; completed: number; total: number; task: string } | null;
  status: WorkspaceStartupStatus;
  workbenchMounted: boolean;
  task: string | null;
  error: string | null;
}>()(() => ({
  nativePhase: 'pending',
  nativeStage: 'initialization',
  nativeStep: 'initialization',
  nativeError: null,
  nativeProgress: null,
  status: 'idle',
  workbenchMounted: false,
  task: null,
  error: null,
}));

/** Mounting the shell and admitting business interaction are separate barriers. */
export function isWorkspaceInteractive(state: {
  nativePhase: NativeStartupPhase;
  status: WorkspaceStartupStatus;
  workbenchMounted: boolean;
}): boolean {
  return state.nativePhase === 'ready'
    && (state.status === 'ready' || state.status === 'degraded')
    && state.workbenchMounted;
}

/** Native responses and the foreground readiness promise can settle out of order. */
export function applyNativeStartupStatus(status: StartupStatus): void {
  const stage = status.stage ?? (status.step === 'versionInitialization' || status.step === 'initialization'
    ? 'initialization' : 'workspacePreparation');
  useWorkspaceStartupStore.setState((state) => {
    if (state.nativePhase === 'ready' && status.phase !== 'ready') return state;
    if (state.nativeStage === 'workspacePreparation' && stage === 'initialization') return state;
    if (state.nativePhase === status.phase && state.nativeStage === stage
      && state.nativeStep === status.step && state.nativeError === status.error
      && state.nativeProgress?.percent === status.progress?.percent
      && state.nativeProgress?.task === status.progress?.task
      && state.nativeProgress?.completed === status.progress?.completed
      && state.nativeProgress?.total === status.progress?.total) return state;
    return { ...state, nativePhase: status.phase, nativeStage: stage,
      nativeStep: status.step, nativeError: status.error, nativeProgress: status.progress ?? null };
  });
}
