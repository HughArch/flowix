export const PLAYER_LOAD_TIMEOUT_MS = 15000;
const PLAYER_PAINT_DELAY_MS = 200;

/** Covers iframe initialization; load does not guarantee cross-origin media readiness. */
export function coverPlayerUntilLoaded(frame: HTMLIFrameElement, retry: () => void): () => void {
  const doc = frame.ownerDocument;
  const surface = doc.createElement('div');
  surface.className = 'editor-video-embed__player-surface';
  surface.setAttribute('aria-busy', 'true');
  const cover = doc.createElement('div');
  cover.className = 'editor-video-embed__empty editor-video-embed__loading-cover';
  cover.setAttribute('role', 'status');
  cover.textContent = '正在加载播放器…';
  frame.replaceWith(surface);
  surface.append(frame, cover);
  frame.classList.add('is-loading');

  let disposed = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let revealTimer: ReturnType<typeof setTimeout> | undefined;
  let observer: IntersectionObserver | undefined;
  const clearTimers = () => { clearTimeout(timeout); clearTimeout(revealTimer); };
  const fail = () => {
    if (disposed) return;
    clearTimers();
    observer?.disconnect();
    surface.setAttribute('aria-busy', 'false');
    cover.dataset.state = 'error';
    cover.textContent = '播放器加载超时，请重试';
    const button = doc.createElement('button');
    button.type = 'button';
    button.textContent = '重新加载';
    button.onclick = () => { if (!disposed) retry(); };
    cover.append(button);
  };
  const startTimeout = () => {
    if (disposed || timeout !== undefined) return;
    timeout = setTimeout(fail, PLAYER_LOAD_TIMEOUT_MS);
  };
  const onLoad = () => {
    if (disposed) return;
    clearTimers();
    observer?.disconnect();
    revealTimer = setTimeout(() => {
      if (disposed) return;
      frame.classList.remove('is-loading');
      cover.remove();
      surface.setAttribute('aria-busy', 'false');
    }, PLAYER_PAINT_DELAY_MS);
  };
  frame.addEventListener('load', onLoad);
  // Lazy iframes outside the viewport must not time out before loading starts.
  if (typeof IntersectionObserver !== 'undefined') {
    observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { startTimeout(); observer?.disconnect(); }
    });
    observer.observe(surface);
  } else {
    startTimeout();
  }
  return () => {
    disposed = true;
    clearTimers();
    observer?.disconnect();
    frame.removeEventListener('load', onLoad);
  };
}
