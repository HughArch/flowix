import { beforeEach, expect, it } from 'vitest';
import { useNotebookBackgroundStore as store } from './notebook-background-store';
beforeEach(() => store.setState({ statuses: {} }));
it('rejects late snapshots and completed results from an older refresh', () => {
  store.getState().apply({ notebookId: 'a', state: 'running', revision: 2, message: null });
  expect(store.getState().apply({ notebookId: 'a', state: 'ready', revision: 1, memoCount: 0, message: null })).toBe(false);
  expect(store.getState().statuses.a.state).toBe('running');
});
it('does not regress from completion to a late running event', () => {
  store.getState().apply({ notebookId: 'a', state: 'ready', revision: 1, memoCount: 3, message: null });
  expect(store.getState().apply({ notebookId: 'a', state: 'running', revision: 1, message: null })).toBe(false);
  expect(store.getState().statuses.a.memoCount).toBe(3);
});
it('keeps failed and unknown counts distinct from a known empty notebook', () => {
  store.getState().apply({ notebookId: 'a', state: 'failed', revision: 1, message: 'offline' });
  store.getState().apply({ notebookId: 'b', state: 'ready', revision: 2, memoCount: 0, message: null });
  expect(store.getState().statuses.a.memoCount).toBeUndefined();
  expect(store.getState().statuses.b.memoCount).toBe(0);
});

it('keeps a failure when an earlier pending query arrives late, and admits explicit retry', () => {
  store.getState().apply({ notebookId: 'a', state: 'failed', revision: 4, message: 'offline' });
  store.getState().pending('a');
  expect(store.getState().statuses.a).toMatchObject({ state: 'failed', revision: 4, message: 'offline' });
  store.getState().pending('a', true);
  expect(store.getState().statuses.a.state).toBe('queued');
  store.getState().apply({ notebookId: 'a', state: 'running', revision: 5, message: null });
  expect(store.getState().statuses.a.state).toBe('running');
});
