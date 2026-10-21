import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  subscriptions: [] as Array<{ wake: () => void; ready: () => void; stop: () => void }>,
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@platform/tauri/event-bus', () => ({
  subscribe: (_event: string, wake: () => void, options: { onListenerReady: () => void }) => {
    const stop = vi.fn();
    mocks.subscriptions.push({ wake, ready: options.onListenerReady, stop });
    return stop;
  },
}));

import { subscribePendingOpenTargets, type PendingOpenTarget } from './pending-requests';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const request = (id: string): PendingOpenTarget => ({ id, target: { kind: 'path', path: `${id}.md` } });
let pending: PendingOpenTarget[];
let cleanup: Array<() => void>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.subscriptions.length = 0;
  pending = [request('cold-start')];
  cleanup = [];
  mocks.invoke.mockImplementation(async (command: string, args: { ids?: string[] }) => {
    if (command === 'get_pending_open_targets') return [...pending];
    pending = pending.filter((item) => !args.ids?.includes(item.id));
  });
});
afterEach(() => { cleanup.forEach((stop) => stop()); });

function mount(receive: (request: PendingOpenTarget) => void | Promise<void>) {
  const stop = subscribePendingOpenTargets('path', receive);
  cleanup.push(stop);
  return { ...mocks.subscriptions[mocks.subscriptions.length - 1], stop };
}

describe('pending native file-open delivery', () => {
  it('recovers a cold-start request without an event, acknowledging only after receipt', async () => {
    const opened = deferred<void>();
    const receive = vi.fn(() => opened.promise);
    const subscription = mount(receive);
    expect(mocks.invoke).not.toHaveBeenCalled();
    subscription.ready();
    await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce());
    expect(pending).toHaveLength(1);
    opened.resolve();
    await vi.waitFor(() => expect(pending).toHaveLength(0));
  });

  it('fetches again when another OS open arrives during an existing delivery', async () => {
    const opened = deferred<void>();
    const receive = vi.fn().mockImplementationOnce(() => opened.promise);
    const subscription = mount(receive);
    subscription.ready();
    await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce());
    pending.push(request('second-instance'));
    subscription.wake();
    opened.resolve();
    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(pending).toHaveLength(0));
  });

  it('leaves a snapshot unacknowledged if its consumer unmounts before delivery', async () => {
    const snapshot = deferred<PendingOpenTarget[]>();
    mocks.invoke.mockImplementationOnce(() => snapshot.promise);
    const receive = vi.fn();
    const first = mount(receive);
    first.ready();
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledOnce());
    first.stop();
    snapshot.resolve([...pending]);
    const replacement = mount(receive);
    replacement.ready();
    await vi.waitFor(() => expect(pending).toHaveLength(0));
    expect(receive).toHaveBeenCalledOnce();
  });

  it('serializes a replacement consumer behind an open already in progress', async () => {
    const opened = deferred<void>();
    const firstReceive = vi.fn(() => opened.promise);
    const first = mount(firstReceive);
    first.ready();
    await vi.waitFor(() => expect(firstReceive).toHaveBeenCalledOnce());
    first.stop();
    const replacementReceive = vi.fn();
    const replacement = mount(replacementReceive);
    replacement.ready();
    opened.resolve();
    await vi.waitFor(() => expect(pending).toHaveLength(0));
    await vi.waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === 'get_pending_open_targets')).toHaveLength(2));
    expect(replacementReceive).not.toHaveBeenCalled();
  });

  it('retains requests when delivery fails so a subsequent wake can retry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const receive = vi.fn().mockRejectedValueOnce(new Error('not ready')).mockResolvedValue(undefined);
    const subscription = mount(receive);
    subscription.ready();
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(pending).toHaveLength(1);
    subscription.wake();
    await vi.waitFor(() => expect(pending).toHaveLength(0));
    warn.mockRestore();
  });
});
