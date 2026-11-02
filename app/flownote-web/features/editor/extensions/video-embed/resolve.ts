import { resolveProviderVideo } from './providers/runtime';
import { isVideoReady, type VideoInfo } from './providers';

// Only deduplicate active requests. Resolved IDs are persisted on the node,
// so a process-wide cache would keep growing as more notes are opened.
const pending = new Map<string, Promise<VideoInfo>>();

export function resolveVideo(video: VideoInfo): Promise<VideoInfo> {
  if (isVideoReady(video)) return Promise.resolve(video);
  const cached = pending.get(video.sourceUrl);
  if (cached) return cached;

  const request = (async () => {
    // Keep provider-specific IPC here; Markdown parsing stays network-free.
    const resolved = await resolveProviderVideo(video);
    if (!isVideoReady(resolved)) throw new Error('视频播放信息不完整');
    return resolved;
  })();
  pending.set(video.sourceUrl, request);
  const cleanup = () => { pending.delete(video.sourceUrl); };
  // Handle both outcomes without creating an unhandled rejected promise.
  void request.then(cleanup, cleanup);
  return request;
}
