import { bilibili } from './providers/bilibili';
import { youtube } from './providers/youtube';
import type { VideoInfo, VideoProvider } from './providers/types';
export type { VideoInfo, VideoProvider } from './providers/types';

export const videoProviders: readonly VideoProvider[] = [bilibili, youtube];

export function parseVideoUrl(value: string): VideoInfo | null {
  try {
    const url = new URL(value.trim().replace(/&amp;/g, '&'));
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    for (const provider of videoProviders) {
      const video = provider.parse(url);
      if (video) return video;
    }
  } catch { /* Unsupported or malformed links remain ordinary links. */ }
  return null;
}

/** Re-derive trusted attributes instead of accepting arbitrary iframe URLs. */
export function normalizeVideoInfo(attrs: Record<string, unknown> | undefined): VideoInfo | null {
  if (typeof attrs?.sourceUrl !== 'string') return null;
  const video = parseVideoUrl(attrs.sourceUrl);
  if (!video) return null;
  return getVideoProvider(video.provider).normalize?.(video, attrs) ?? video;
}

export function getVideoProvider(id: string): VideoProvider {
  const provider = videoProviders.find(provider => provider.id === id);
  if (!provider) throw new Error(`Unsupported video provider: ${id}`);
  return provider;
}

export function isVideoReady(video: VideoInfo): boolean {
  return getVideoProvider(video.provider).isReady(video);
}

export function videoEmbedUrl(video: VideoInfo): string {
  return getVideoProvider(video.provider).buildEmbedUrl(video);
}

export function videoHtmlMetadata(video: VideoInfo): Record<string, string> {
  const metadata = getVideoProvider(video.provider).metadata?.(video);
  return metadata && Object.keys(metadata).length > 0
    ? { 'data-video-metadata': JSON.stringify(metadata) } : {};
}

export function parseVideoHtml(element: HTMLElement): VideoInfo | null {
  let metadata: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(element.getAttribute('data-video-metadata') ?? '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>;
  } catch { /* Invalid metadata can be resolved again from the source link. */ }
  return normalizeVideoInfo({
    // Legacy Bilibili HTML remains readable.
    aid: Number(element.getAttribute('data-aid')),
    cid: Number(element.getAttribute('data-cid')),
    ...metadata,
    sourceUrl: element.getAttribute('data-source-url'),
  });
}
