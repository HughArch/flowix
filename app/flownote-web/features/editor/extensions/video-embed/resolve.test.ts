import { afterEach, expect, it, vi } from 'vitest';
import { web } from '@platform/tauri/client';
import { parseVideoUrl } from './providers';
import { resolveVideo } from './resolve';

vi.mock('@platform/tauri/client', () => ({ web: { resolveBilibiliVideo: vi.fn() } }));
afterEach(() => { vi.restoreAllMocks(); });

it('preserves native errors without falling back to a cross-origin fetch, and permits retry', async () => {
  const video = parseVideoUrl('https://www.bilibili.com/video/BV1TGnP6VE2f')!;
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  vi.mocked(web.resolveBilibiliVideo).mockRejectedValueOnce(new Error('Bilibili HTTP 412'));
  await expect(resolveVideo(video)).rejects.toThrow('Bilibili HTTP 412');
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.mocked(web.resolveBilibiliVideo).mockResolvedValueOnce({ aid: 117472724261620, cid: 42907075029 });
  await expect(resolveVideo(video)).resolves.toMatchObject({ aid: 117472724261620, cid: 42907075029 });
});

it('deduplicates concurrent requests and releases completed requests', async () => {
  const video = parseVideoUrl('https://www.bilibili.com/video/BV1xx411c7mD')!;
  const ids = { aid: 123, cid: 42 };
  let finish!: (value: typeof ids) => void;
  vi.mocked(web.resolveBilibiliVideo).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const first = resolveVideo(video);
  const second = resolveVideo(video);
  expect(first).toBe(second);
  finish(ids);
  await expect(first).resolves.toMatchObject(ids);
  vi.mocked(web.resolveBilibiliVideo).mockResolvedValueOnce(ids);
  expect(resolveVideo(video)).not.toBe(first);
  await resolveVideo(video);
});

it('uses persisted IDs and rejects invalid native playback information', async () => {
  const video = parseVideoUrl('https://www.bilibili.com/video/BV1xx411c7mD?p=2')!;
  const resolved = { ...video, aid: 123, cid: 42 };
  await expect(resolveVideo(resolved)).resolves.toBe(resolved);
  vi.mocked(web.resolveBilibiliVideo).mockResolvedValueOnce({ aid: 123, cid: 0 });
  await expect(resolveVideo(video)).rejects.toThrow('视频播放信息不完整');
});
