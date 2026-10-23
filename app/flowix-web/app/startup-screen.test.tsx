import { act, lazy, Suspense, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StartupGate } from './startup-screen';
import { applyNativeStartupStatus, useWorkspaceStartupStore as store } from '@/lib/store/workspace-startup-store';

const mocks = vi.hoisted(() => ({ retry: vi.fn() }));
vi.mock('@platform/tauri/client', () => ({ boot: { retryStartup: mocks.retry } }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@shared/ui/button', () => ({ Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} /> }));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  store.setState(store.getInitialState(), true);
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it('defers workbench code and effects through initialization, even at 100%, then mounts in stage 2', async () => {
  const mounted = vi.fn();
  function Workbench() {
    useEffect(mounted, []);
    return <div data-workbench />;
  }
  const load = vi.fn(async () => ({ default: Workbench }));
  const LazyWorkbench = lazy(load);
  await act(async () => root.render(<StartupGate><Suspense fallback={null}><LazyWorkbench /></Suspense></StartupGate>));
  await act(async () => applyNativeStartupStatus({ phase: 'running', stage: 'initialization', step: 'versionInitialization', error: null,
    progress: { percent: 100, completed: 2, total: 2, task: 'completeInitialization' } }));
  expect(container.querySelector('[data-startup-screen="initialization"]')).not.toBeNull();
  expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('100');
  expect(load).not.toHaveBeenCalled();
  expect(mounted).not.toHaveBeenCalled();

  await act(async () => applyNativeStartupStatus({ phase: 'running', stage: 'workspacePreparation', step: 'preparingData', error: null }));
  expect(load).toHaveBeenCalledTimes(1);
  expect(mounted).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[data-workbench]')).not.toBeNull();
  expect(container.querySelector('[data-startup-screen]')).toBeNull();
  await act(async () => applyNativeStartupStatus({ phase: 'ready', stage: 'workspacePreparation', step: 'ready', error: null }));
  expect(mounted).toHaveBeenCalledTimes(1);
});

it('keeps initialization failures on the standalone page and exposes retry errors', async () => {
  mocks.retry.mockRejectedValueOnce(new Error('retry unavailable'));
  store.setState({ nativePhase: 'failed', nativeError: 'migration unavailable' });
  await act(async () => root.render(<StartupGate><div data-workbench /></StartupGate>));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('migration unavailable');
  expect(container.querySelector('[data-workbench]')).toBeNull();
  await act(async () => container.querySelector('button')!.click());
  expect(mocks.retry).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('retry unavailable');
  expect(container.querySelector('button')?.disabled).toBe(false);
});

it('enters the workbench directly when version initialization is skipped', async () => {
  store.setState({ nativePhase: 'running', nativeStage: 'workspacePreparation' });
  await act(async () => root.render(<StartupGate><div data-workbench /></StartupGate>));
  expect(container.querySelector('[data-workbench]')).not.toBeNull();
  expect(container.querySelector('[data-startup-screen]')).toBeNull();
});
