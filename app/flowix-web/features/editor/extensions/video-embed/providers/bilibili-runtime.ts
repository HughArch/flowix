import { web } from '@platform/tauri/client';
import type { VideoInfo } from './types';
import type { BilibiliVideoInfo } from './bilibili';

/** Bilibili alone owns its native service and playback IDs. */
export async function resolveBilibili(video: VideoInfo): Promise<BilibiliVideoInfo> {
  if (video.provider !== 'bilibili') throw new Error('Bilibili resolver mismatch');
  const { aid, cid } = await web.resolveBilibiliVideo(video.videoId, video.page);
  return { ...video, aid, cid };
}
