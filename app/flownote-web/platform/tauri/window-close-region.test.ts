import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const invoke = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('./core', () => ({ invoke }));
import { registerWindowCloseRegion, subscribeNativeCloseRouting } from './window-close-region';
let cleanups: Array<() => void> = [];
beforeEach(() => {
  invoke.mockClear();
  vi.stubGlobal('ResizeObserver', class {
    observe() {} disconnect() {}
  });
});
afterEach(() => {
  cleanups.forEach(cleanup => cleanup()); cleanups = [];
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});
function button() {
  const element = document.createElement('button');
  document.body.append(element);
  element.getClientRects = () => ({ length: 1 }) as DOMRectList;
  element.getBoundingClientRect = () => ({ right: window.innerWidth, top: 0, width: 42, height: 36 }) as DOMRect;
  return element;
}
it('publishes the actual close-button rectangle in physical pixels', () => {
  vi.stubGlobal('devicePixelRatio', 2);
  cleanups.push(registerWindowCloseRegion(button()));
  expect(invoke).toHaveBeenLastCalledWith('set_window_close_region', {
    revision: expect.any(Number), region: { rightInset: 0, top: 0, width: 84, height: 72 },
  });
});
it('keeps another mounted control active when an overlapping host unmounts', () => {
  const disposeFirst = registerWindowCloseRegion(button());
  const disposeSecond = registerWindowCloseRegion(button());
  disposeSecond();
  expect(invoke.mock.lastCall?.[1].region).not.toBeNull();
  disposeFirst();
  expect(invoke.mock.lastCall?.[1].region).toBeNull();
  const revisions = invoke.mock.calls.map(([, args]) => args.revision);
  expect(revisions).toEqual([...revisions].sort((a, b) => a - b));
});
it('reports native routing failure and recovery from the live health command', async () => {
  vi.useFakeTimers();
  invoke.mockImplementation((command: string) => Promise.resolve(
    command === 'native_close_routing_ready' ? false : undefined,
  ));
  cleanups.push(registerWindowCloseRegion(button()));
  const listener = vi.fn();
  cleanups.push(subscribeNativeCloseRouting(listener));

  await vi.advanceTimersByTimeAsync(2_000);
  expect(listener).toHaveBeenLastCalledWith(false);

  invoke.mockImplementation((command: string) => Promise.resolve(
    command === 'native_close_routing_ready' ? true : undefined,
  ));
  await vi.advanceTimersByTimeAsync(2_000);
  expect(listener).toHaveBeenLastCalledWith(true);
});
