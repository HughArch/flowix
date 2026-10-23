import { beforeEach, expect, it } from 'vitest';
import { isWorkspaceInteractive, applyNativeStartupStatus as apply, useWorkspaceStartupStore as store } from './workspace-startup-store';
beforeEach(() => store.setState({ nativePhase: 'pending', nativeStage: 'initialization', nativeStep: 'initialization', nativeProgress: null, nativeError: null }));
it('rejects a late initialization response after workspace preparation starts', () => {
  apply({ phase: 'running', stage: 'workspacePreparation', step: 'preparingData', error: null });
  apply({ phase: 'running', stage: 'initialization', step: 'versionInitialization', error: null,
    progress: { percent: 30, completed: 0, total: 2, task: 'runMigrations' } });
  expect(store.getState().nativeStage).toBe('workspacePreparation');
  expect(store.getState().nativeProgress).toBeNull();
});
it('keeps the shell ready when an earlier polling response arrives late', () => {
  store.setState({ nativePhase: 'ready', nativeStage: 'workspacePreparation' });
  apply({ phase: 'running', stage: 'workspacePreparation', step: 'preparingData', error: null });
  expect(store.getState().nativePhase).toBe('ready');
});
it('allows retry within the failed stage', () => {
  apply({ phase: 'failed', stage: 'workspacePreparation', step: 'preparingData', error: 'unavailable' });
  apply({ phase: 'pending', stage: 'workspacePreparation', step: 'preparingData', error: null });
  expect(store.getState().nativePhase).toBe('pending');
  expect(store.getState().nativeStage).toBe('workspacePreparation');
});

it('admits interaction only after native readiness, workspace readiness and shell mount', () => {
  const ready = { nativePhase: 'ready' as const, status: 'ready' as const, workbenchMounted: true };
  expect(isWorkspaceInteractive(ready)).toBe(true);
  expect(isWorkspaceInteractive({ ...ready, status: 'degraded' })).toBe(true);
  for (const nativePhase of ['pending', 'running', 'failed'] as const) {
    expect(isWorkspaceInteractive({ ...ready, nativePhase })).toBe(false);
  }
  for (const status of ['idle', 'running', 'failed'] as const) {
    expect(isWorkspaceInteractive({ ...ready, status })).toBe(false);
  }
  expect(isWorkspaceInteractive({ ...ready, workbenchMounted: false })).toBe(false);
});
