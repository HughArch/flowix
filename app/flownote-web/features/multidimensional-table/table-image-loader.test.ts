import { expect, it, vi } from 'vitest';
import { TableImageLoader } from './table-image-loader';

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

it('reuses images across appended pages and publishes each completed image', async () => {
  const read = vi.fn(async (path: string) => `url:${path}`);
  const changed = vi.fn();
  const loader = new TableImageLoader(read, changed);
  loader.setPaths(['a', 'a', 'b']);
  await flush();
  expect(read).toHaveBeenCalledTimes(2);
  expect(changed).toHaveBeenCalledTimes(2);
  expect(loader.get('a')).toBe('url:a');
  loader.setPaths(['a', 'b', 'c']);
  await flush();
  expect(read.mock.calls.map(([path]) => path)).toEqual(['a', 'b', 'c']);
});

it('shares a concurrency limit and drops obsolete queued work', async () => {
  const pending = new Map<string, (value: string) => void>();
  const read = vi.fn((path: string) => new Promise<string>((resolve) => pending.set(path, resolve)));
  const changed = vi.fn();
  const loader = new TableImageLoader(read, changed, 2);
  loader.setPaths(['a', 'b', 'obsolete']);
  await flush();
  loader.setPaths(['a', 'b', 'c', 'd']);
  await flush();
  expect(read).toHaveBeenCalledTimes(2);
  pending.get('a')!('url:a');
  await flush();
  expect(read.mock.calls.map(([path]) => path)).toEqual(['a', 'b', 'c']);
  loader.setPaths([]);
  pending.get('b')!('url:b');
  pending.get('c')!('url:c');
  await flush();
  expect(read).toHaveBeenCalledTimes(3);
  expect(changed).toHaveBeenCalledTimes(1);
});

it('caches failures without retrying on every render', async () => {
  const read = vi.fn(async () => { throw new Error('missing'); });
  const changed = vi.fn();
  const loader = new TableImageLoader(read, changed, 1);
  loader.setPaths(['missing']);
  await flush();
  expect(loader.get('missing')).toBeNull();
  loader.setPaths(['missing']);
  await flush();
  expect(read).toHaveBeenCalledTimes(1);

});
