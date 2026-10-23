import type { BilibiliVideoInfo } from './bilibili';
import type { YouTubeVideoInfo } from './youtube';

export interface VideoSource {
  videoId: string;
  sourceUrl: string;
}

/** The provider discriminant determines which playback fields are valid. */
export type VideoInfo = BilibiliVideoInfo | YouTubeVideoInfo;

/** Pure definitions only. Native resolution belongs to runtime adapters. */
export interface VideoProvider {
  id: VideoInfo['provider'];
  displayName: string;
  attributes: Record<string, { default: unknown }>;
  parse(url: URL): VideoInfo | null;
  isReady(video: VideoInfo): boolean;
  buildEmbedUrl(video: VideoInfo): string;
  normalize?(video: VideoInfo, attrs: Record<string, unknown>): VideoInfo;
  metadata?(video: VideoInfo): Record<string, unknown>;
}
