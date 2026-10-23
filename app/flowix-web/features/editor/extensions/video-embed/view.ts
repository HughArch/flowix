import { coverPlayerUntilLoaded } from './player-loading';
import type { NodeViewRenderer } from '@tiptap/core';
import { DOMSerializer, type DOMOutputSpec } from '@tiptap/pm/model';
import { getVideoProvider, videoHtmlMetadata, isVideoReady, normalizeVideoInfo, videoEmbedUrl, type VideoInfo } from './providers';
import { resolveVideo } from './resolve';

function wrapperAttributes(video: VideoInfo | null): Record<string, string> {
  return {
    'data-video-embed': '',
    class: 'editor-video-embed',
    ...(video ? { 'data-source-url': video.sourceUrl } : {}),
    ...(video ? videoHtmlMetadata(video) : {}),
    contenteditable: 'false',
    style: 'width:100%;max-width:960px;margin:16px 0;',
  };
}

/** Shared by the live node view, HTML export and editor copy/paste. */
export function renderVideoEmbed(video: VideoInfo | null): DOMOutputSpec {
  const attributes = wrapperAttributes(video);
  if (!video) return ['div', attributes, ['div', { class: 'editor-video-embed__empty', 'data-state': 'error' }, ['p', { role: 'status' }, '视频链接无效']]];
  const provider = getVideoProvider(video.provider);
  const sourceLabel = `在 ${provider.displayName} 打开`;
  const source: DOMOutputSpec = ['a', {
    href: video.sourceUrl, target: '_blank', rel: 'noopener noreferrer',
    class: 'editor-video-embed__source', 'aria-label': sourceLabel,
  }, sourceLabel];
  const actions: DOMOutputSpec = ['div', { class: 'editor-video-embed__actions', role: 'group', 'aria-label': '视频操作' }, source];
  if (!isVideoReady(video)) return ['div', attributes, actions,
    ['div', { class: 'editor-video-embed__empty', 'data-state': 'loading' },
      ['span', { class: 'editor-video-embed__icon', 'aria-hidden': 'true' }, '▷'],
      ['p', { role: 'status' }, '正在解析视频播放信息…']]];
  return ['div', attributes, ['iframe', {
    class: 'editor-video-embed__player',
    src: videoEmbedUrl(video), title: `${provider.displayName} 视频`,
    loading: 'lazy', allow: 'fullscreen; picture-in-picture; encrypted-media',
    allowfullscreen: 'true', referrerpolicy: 'strict-origin-when-cross-origin',
    sandbox: 'allow-scripts allow-same-origin allow-presentation',
    style: 'display:block;width:100%;aspect-ratio:16/9;border:0;border-radius:8px;',
  }], actions];
}

export const createVideoEmbedView: NodeViewRenderer = ({ node, getPos, editor }) => {
  let current = node;
  let destroyed = false;
  let generation = 0;
  const dom = document.createElement('div');
  let cleanupPlayer: (() => void) | undefined;

  const render = () => {
    if (destroyed || editor.isDestroyed) return;
    cleanupPlayer?.();
    cleanupPlayer = undefined;
    const version = ++generation;
    const video = normalizeVideoInfo(current.attrs);
    const rendered = DOMSerializer.renderSpec(document, renderVideoEmbed(video)).dom;
    for (const name of ['data-source-url', 'data-video-metadata', 'data-aid', 'data-cid']) dom.removeAttribute(name);
    for (const [name, value] of Object.entries(wrapperAttributes(video))) {
      if (name === 'class') dom.classList.add(value);
      else dom.setAttribute(name, value);
    }
    dom.replaceChildren(...Array.from(rendered.childNodes));
    const actions = dom.querySelector('.editor-video-embed__actions');
    if (actions) {
      const reload = document.createElement('button');
      reload.type = 'button';
      reload.className = 'editor-video-embed__reload';
      reload.textContent = '重新加载';
      reload.onclick = render;
      actions.append(reload);
    }
    const frame = dom.querySelector<HTMLIFrameElement>('iframe');
    if (frame) cleanupPlayer = coverPlayerUntilLoaded(frame, render);
    if (!video || isVideoReady(video)) return;

    const empty = dom.querySelector<HTMLElement>('.editor-video-embed__empty')!;
    const status = empty.querySelector<HTMLElement>('[role="status"]')!;
    void resolveVideo(video).then(resolved => {
      if (destroyed || version !== generation || editor.isDestroyed) return;
      const pos = getPos();
      if (typeof pos !== 'number' || !editor.state.doc.nodeAt(pos)?.eq(current)) return;
      editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, ...resolved })
        .setMeta('addToHistory', false));
    }).catch(error => {
      if (destroyed || version !== generation) return;
      console.warn('[video-embed] Native video resolution failed', error);
      empty.dataset.state = 'error';
      status.textContent = '视频解析失败';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = '重新加载';
      retry.onclick = render;
      empty.append(retry);
    });
  };
  render();
  return {
    dom,
    ignoreMutation: () => true,
    stopEvent: event => event.target instanceof Element && !!event.target.closest('iframe, a, button'),
    update(next) {
      if (next.type !== current.type) return false;
      const changed = !next.eq(current);
      current = next;
      if (changed) render();
      return true;
    },
    destroy() { destroyed = true; generation += 1; cleanupPlayer?.(); },
  };
};
