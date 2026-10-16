import { create } from 'zustand';

export type WorkspaceStartupStatus = 'idle' | 'running' | 'ready' | 'degraded' | 'failed';
export type NativeStartupPhase = 'pending' | 'running' | 'ready' | 'failed';
export type StartupTaskOutcome = 'pending' | 'ready' | 'failed';

/** Process-local stage 2 barrier. Never persist startup progress across launches. */
export const useWorkspaceStartupStore = create<{
  nativePhase: NativeStartupPhase;
  nativeStage: 'initialization' | 'workspacePreparation';
  nativeStep: string;
  nativeError: string | null;
  nativeProgress: { percent: number; completed: number; total: number; task: string } | null;
  status: WorkspaceStartupStatus;
  task: string | null;
  error: string | null;
  startupTasks: Record<string, StartupTaskOutcome>;
  setStartupTask: (task: string, outcome: StartupTaskOutcome) => void;
}>()((set) => ({
  nativePhase: 'pending',
  nativeStage: 'initialization',
  nativeStep: 'initialization',
  nativeError: null,
  nativeProgress: null,
  status: 'idle',
  task: null,
  error: null,
  startupTasks: {},
  setStartupTask: (task, outcome) => set((state) => ({
    startupTasks: { ...state.startupTasks, [task]: outcome },
  })),
}));

export function waitForStartupTask(task: string | null, timeoutMs = 60_000): Promise<'ready' | 'failed' | 'timeout'> {
  if (!task) return Promise.resolve('ready');
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: 'ready' | 'failed' | 'timeout') => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      unsubscribe();
      resolve(result);
    };
    const check = () => {
      const outcome = useWorkspaceStartupStore.getState().startupTasks[task];
      if (outcome === 'ready' || outcome === 'failed') finish(outcome);
    };
    const unsubscribe = useWorkspaceStartupStore.subscribe(check);
    const timeout = setTimeout(() => finish('timeout'), timeoutMs);
    check();
  });
}
