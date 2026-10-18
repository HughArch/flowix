import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CloudState } from '@platform/tauri/client';
import { useCloudAccountState } from './use-cloud-account-state';

const mocks = vi.hoisted(() => ({
  getState: vi.fn(), refreshMembership: vi.fn(), unlisten: vi.fn(),
  receive: null as null | ((state: CloudState) => void),
  ready: null as null | (() => void),
}));
vi.mock('@platform/tauri/client', () => ({
  cloud: { getState: mocks.getState, refreshMembership: mocks.refreshMembership },
  listenToCloudStateChanges: (receive: (state: CloudState) => void, options?: { onListenerReady?: () => void }) => {
    mocks.receive = receive;
    mocks.ready = options?.onListenerReady ?? null;
    return mocks.unlisten;
  },
}));

let root: Root;
let container: HTMLDivElement;
let current: ReturnType<typeof useCloudAccountState>;
function Harness() {
  current = useCloudAccountState();
  return <div>{current.state?.revision ?? 'pending'}</div>;
}
function snapshot(revision: number): CloudState {
  return { revision, authenticated: false, authStatus: 'signed_out' };
}
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.refreshMembership.mockResolvedValue({});
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

it('recovers changes missed while the native listener was being registered', async () => {
  mocks.getState.mockResolvedValueOnce(snapshot(1)).mockResolvedValueOnce(snapshot(3));
  await act(async () => root.render(<Harness />));
  expect(current.state?.revision).toBe(1);
  await act(async () => mocks.ready!());
  expect(current.state?.revision).toBe(3);
  expect(mocks.getState).toHaveBeenCalledTimes(2);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

it('rejects stale queries and command results after a newer account event', async () => {
  let resolve!: (state: CloudState) => void;
  mocks.getState.mockReturnValue(new Promise<CloudState>((done) => { resolve = done; }));
  await act(async () => root.render(<Harness />));
  await act(async () => mocks.receive!(snapshot(3)));
  await act(async () => resolve(snapshot(1)));
  expect(current.state?.revision).toBe(3);
  await act(async () => current.applyState(snapshot(2)));
  expect(current.state?.revision).toBe(3);
  await act(async () => current.applyState(snapshot(4)));
  expect(current.state?.revision).toBe(4);
});

it('does not surface an obsolete query error after receiving a valid state', async () => {
  let reject!: (error: Error) => void;
  mocks.getState.mockReturnValue(new Promise<CloudState>((_, fail) => { reject = fail; }));
  await act(async () => root.render(<Harness />));
  await act(async () => mocks.receive!(snapshot(2)));
  await act(async () => reject(new Error('old query failed')));
  expect(current.loadError).toBeNull();
  expect(current.state?.revision).toBe(2);
});

it('reports initial query failure and recovers through a later state event', async () => {
  mocks.getState.mockRejectedValue(new Error('offline'));
  await act(async () => root.render(<Harness />));
  expect(current.loadError).toBe('offline');
  expect(current.loading).toBe(false);
  await act(async () => mocks.receive!({ ...snapshot(1), authStatus: 'restoring' }));
  expect(current.loadError).toBeNull();
  expect(current.loading).toBe(true);
  await act(async () => mocks.receive!(snapshot(2)));
  expect(current.loading).toBe(false);
});

it('removes subscriptions and ignores a query response after unmount', async () => {
  let resolve!: (state: CloudState) => void;
  mocks.getState.mockReturnValue(new Promise<CloudState>((done) => { resolve = done; }));
  await act(async () => root.render(<Harness />));
  await act(async () => root.unmount());
  await act(async () => resolve(snapshot(1)));
  expect(mocks.unlisten).toHaveBeenCalledOnce();
  expect(current.state).toBeNull();
});

it('shows membership failures and allows a successful retry', async () => {
  mocks.getState.mockResolvedValue({ ...snapshot(1), authenticated: true, authStatus: 'authenticated' });
  mocks.refreshMembership.mockRejectedValueOnce(new Error('offline'));
  await act(async () => root.render(<Harness />));
  expect(current.membershipError).toBe('offline');
  expect(current.membershipLoading).toBe(false);
  await act(async () => current.refreshMembership());
  expect(current.membershipError).toBeNull();
  expect(mocks.refreshMembership).toHaveBeenCalledTimes(2);
});

it('ignores a membership failure from a previous session', async () => {
  let reject!: (error: Error) => void;
  mocks.getState.mockResolvedValue({ ...snapshot(1), authenticated: true, authStatus: 'authenticated' });
  mocks.refreshMembership.mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
  await act(async () => root.render(<Harness />));
  expect(current.membershipLoading).toBe(true);
  await act(async () => mocks.receive!(snapshot(2)));
  await act(async () => reject(new Error('old failure')));
  expect(current.membershipError).toBeNull();
  expect(current.membershipLoading).toBe(false);
});

it('coalesces concurrent membership refreshes and throttles focus refreshes', async () => {
  let resolve!: () => void;
  mocks.getState.mockResolvedValue({ ...snapshot(1), authenticated: true, authStatus: 'authenticated', account: { user: { id: 'user-1' } } } as CloudState);
  mocks.refreshMembership.mockReturnValueOnce(new Promise((done) => { resolve = () => done({}); }));
  vi.spyOn(Date, 'now').mockReturnValue(100_000);
  await act(async () => root.render(<Harness />));
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('focus'));
  });
  expect(mocks.refreshMembership).toHaveBeenCalledTimes(1);
  await act(async () => resolve());
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(mocks.refreshMembership).toHaveBeenCalledTimes(1);
});

it('clears the focus throttle after logout so the next session reloads membership', async () => {
  mocks.getState.mockResolvedValue({ ...snapshot(1), authenticated: true, authStatus: 'authenticated', account: { user: { id: 'user-1' } } } as CloudState);
  await act(async () => root.render(<Harness />));
  expect(mocks.refreshMembership).toHaveBeenCalledTimes(1);
  await act(async () => mocks.receive!(snapshot(2)));
  await act(async () => mocks.receive!({ ...snapshot(3), authenticated: true, authStatus: 'authenticated', account: { user: { id: 'user-1' } } } as CloudState));
  expect(mocks.refreshMembership).toHaveBeenCalledTimes(2);
});
