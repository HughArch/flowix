import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { coverPlayerUntilLoaded, PLAYER_LOAD_TIMEOUT_MS } from './player-loading';

let cleanup: (() => void) | undefined;
beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup?.(); cleanup = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
function setup() {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  const retry = vi.fn();
  cleanup = coverPlayerUntilLoaded(frame, retry);
  return { frame, retry };
}
it('shows a retry after timeout and allows a late load to recover', () => {
  const { frame, retry } = setup();
  vi.advanceTimersByTime(PLAYER_LOAD_TIMEOUT_MS);
  expect(document.body.textContent).toContain('播放器加载超时');
  document.querySelector('button')!.click();
  expect(retry).toHaveBeenCalledOnce();
  frame.dispatchEvent(new Event('load'));
  vi.advanceTimersByTime(200);
  expect(frame.classList.contains('is-loading')).toBe(false);
  expect(document.querySelector('.editor-video-embed__loading-cover')).toBeNull();
});
it('does not time out after a successful load', () => {
  const { frame } = setup();
  frame.dispatchEvent(new Event('load'));
  vi.advanceTimersByTime(PLAYER_LOAD_TIMEOUT_MS);
  expect(document.querySelector('button')).toBeNull();
  expect(frame.classList.contains('is-loading')).toBe(false);
});
it('cancels timers and callbacks when destroyed', () => {
  const { frame } = setup();
  frame.dispatchEvent(new Event('load'));
  cleanup!();
  vi.advanceTimersByTime(PLAYER_LOAD_TIMEOUT_MS);
  expect(document.querySelector('button')).toBeNull();
  expect(frame.classList.contains('is-loading')).toBe(true);
});
it('starts the timeout only after a lazy player enters the viewport', () => {
  let notify!: IntersectionObserverCallback;
  const disconnect = vi.fn();
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { notify = callback; }
    observe() {}
    disconnect = disconnect;
  });
  setup();
  vi.advanceTimersByTime(PLAYER_LOAD_TIMEOUT_MS);
  expect(document.querySelector('button')).toBeNull();
  notify([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
  vi.advanceTimersByTime(PLAYER_LOAD_TIMEOUT_MS);
  expect(document.querySelector('button')).not.toBeNull();
  expect(disconnect).toHaveBeenCalled();
});
