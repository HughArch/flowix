import type { VideoProvider, VideoSource } from './types';

export interface YouTubeVideoInfo extends VideoSource {
  provider: 'youtube';
  start?: number;
}

const VIDEO_ID_RE = /^[\w-]{11}$/;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);

function startSeconds(raw: string | null): number {
  if (!raw) return 0;
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    return Number.isSafeInteger(seconds) ? seconds : 0;
  }
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(raw);
  if (!match || !match[0]) return 0;
  const seconds = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  return Number.isSafeInteger(seconds) ? seconds : 0;
}

export const youtube: VideoProvider = {
  id: 'youtube',
  displayName: 'YouTube',
  attributes: { start: { default: null } },
  // The public iframe needs no separate native metadata request.
  isReady: video => video.provider === 'youtube' && VIDEO_ID_RE.test(video.videoId),
  parse(url) {
    let videoId: string | undefined;
    if (['youtu.be', 'www.youtu.be'].includes(url.hostname)) {
      videoId = /^\/([\w-]{11})\/?$/.exec(url.pathname)?.[1];
    } else if (YOUTUBE_HOSTS.has(url.hostname)) {
      videoId = /^\/watch\/?$/.test(url.pathname)
        ? url.searchParams.get('v') ?? undefined
        : /^\/(?:shorts|live|embed)\/([\w-]{11})\/?$/.exec(url.pathname)?.[1];
    } else if (['youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(url.hostname)) {
      videoId = /^\/embed\/([\w-]{11})\/?$/.exec(url.pathname)?.[1];
    }
    if (!videoId || !VIDEO_ID_RE.test(videoId)) return null;
    const start = startSeconds(url.searchParams.get('t') ?? url.searchParams.get('start')
      ?? new URLSearchParams(url.hash.slice(1)).get('t'));
    const sourceUrl = `https://www.youtube.com/watch?v=${videoId}${start ? `&t=${start}` : ''}`;
    return { provider: 'youtube', videoId, sourceUrl, ...(start ? { start } : {}) };
  },
  buildEmbedUrl(video) {
    if (video.provider !== 'youtube') throw new Error('YouTube provider mismatch');
    const url = new URL(`https://www.youtube-nocookie.com/embed/${video.videoId}`);
    url.searchParams.set('autoplay', '0');
    url.searchParams.set('controls', '1');
    url.searchParams.set('playsinline', '1');
    if (video.start) url.searchParams.set('start', String(video.start));
    return url.href;
  },
};
