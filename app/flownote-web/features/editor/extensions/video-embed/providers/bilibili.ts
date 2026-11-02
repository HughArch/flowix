import type { VideoProvider, VideoSource } from './types';

export interface BilibiliVideoInfo extends VideoSource {
  provider: 'bilibili';
  page: number;
  aid?: number;
  cid?: number;
}

function isPlaybackId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export const bilibili: VideoProvider = {
  id: 'bilibili',
  displayName: 'Bilibili',
  attributes: { page: { default: 1 }, aid: { default: null }, cid: { default: null } },
  isReady: video => video.provider === 'bilibili' && isPlaybackId(video.aid) && isPlaybackId(video.cid),
  normalize(video, attrs) {
    if (video.provider !== 'bilibili') throw new Error('Bilibili provider mismatch');
    const metadata: Pick<BilibiliVideoInfo, 'aid' | 'cid'> = {};
    for (const key of ['aid', 'cid'] as const) {
      if (isPlaybackId(attrs[key])) metadata[key] = attrs[key];
    }
    return { ...video, ...metadata };
  },
  metadata(video) {
    if (video.provider !== 'bilibili') throw new Error('Bilibili provider mismatch');
    return {
      ...(isPlaybackId(video.aid) ? { aid: video.aid } : {}),
      ...(isPlaybackId(video.cid) ? { cid: video.cid } : {}),
    };
  },
  parse(url) {
    if (!['bilibili.com', 'www.bilibili.com', 'm.bilibili.com'].includes(url.hostname)) return null;
    const match = /^\/(?:[a-z]{2}(?:-[a-zA-Z]{2,8})*\/)?video\/(BV[0-9A-Za-z]{10}|av[1-9]\d*)\/?$/.exec(url.pathname);
    if (!match) return null;
    const rawPage = url.searchParams.get('p') ?? '1';
    const page = /^\d+$/.test(rawPage) && Number.isSafeInteger(Number(rawPage)) && Number(rawPage) > 0
      ? Number(rawPage) : 1;
    const sourceUrl = `https://www.bilibili.com/video/${match[1]}${page > 1 ? `?p=${page}` : ''}`;
    return { provider: 'bilibili', videoId: match[1], sourceUrl, page };
  },
  buildEmbedUrl(video) {
    if (video.provider !== 'bilibili') throw new Error('Bilibili provider mismatch');
    const url = new URL('https://player.bilibili.com/player.html');
    url.searchParams.set(video.videoId.startsWith('BV') ? 'bvid' : 'aid', video.videoId.replace(/^av/, ''));
    if (video.aid) url.searchParams.set('aid', String(video.aid));
    if (video.cid) url.searchParams.set('cid', String(video.cid));
    url.searchParams.set('page', String(video.page));
    url.searchParams.set('autoplay', '0');
    return url.href;
  },
};

