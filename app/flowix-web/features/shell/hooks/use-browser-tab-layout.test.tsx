import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { shouldCompactBrowserTabs, useBrowserTabLayout } from './use-browser-tab-layout';

it('includes gaps and the trailing menu target in the compact boundary', () => {
  expect(shouldCompactBrowserTabs(302, 3, 2, 10)).toBe(false);
  expect(shouldCompactBrowserTabs(301, 3, 2, 10)).toBe(true);
  expect(shouldCompactBrowserTabs(0, 0, 2, 8)).toBe(false);
});

it('coalesces resize notifications, rerenders only across a mode boundary, and restores active visibility', async () => {
  let width = 600;
  let outside = false;
  let renders = 0;
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  let notify = () => {};
  const disconnected = vi.fn();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { notify = callback; }
    observe() {}
    disconnect = disconnected;
  });
  const widthSpy = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(() => width);
  const rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return { left: 0, right: this.getAttribute('role') === 'tablist' ? width : width + (outside ? 50 : -10) } as DOMRect;
  });
  const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView');
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const tabs = ['one', 'two', 'three'].map((id) => ({ id }));
  function Harness({ activeId = 'one', items = tabs }) {
    renders++;
    const buttons = useRef(new Map<string, HTMLButtonElement>());
    const { tabListRef, compactTabs } = useBrowserTabLayout(items, activeId, buttons);
    return <div ref={tabListRef} role="tablist" data-compact={compactTabs}>{items.map(({ id }) => <div key={id}><button ref={(node) => { if (node) buttons.current.set(id, node); else buttons.current.delete(id); }}>{id}</button></div>)}</div>;
  }
  const flushFrame = async () => {
    const pending = [...frames.values()];
    frames.clear();
    await act(async () => pending.forEach((callback) => callback(0)));
  };
  try {
    await act(async () => root.render(<Harness />));
    const initialRenders = renders;
    width = 550;
    notify(); notify(); notify();
    expect(frames.size).toBe(1);
    await flushFrame();
    expect(renders).toBe(initialRenders);
    outside = true;
    width = 200;
    notify();
    await flushFrame();
    expect(element.firstElementChild?.getAttribute('data-compact')).toBe('true');
    expect(scrollSpy).toHaveBeenCalled();
    const compactRenders = renders;
    width = 180;
    notify();
    await flushFrame();
    expect(renders).toBe(compactRenders);
    scrollSpy.mockClear();
    await act(async () => root.render(<Harness items={[...tabs].reverse()} />));
    expect(scrollSpy).toHaveBeenCalled();
    scrollSpy.mockClear();
    await act(async () => root.render(<Harness activeId="two" />));
    expect(scrollSpy).toHaveBeenCalled();
    width = 600;
    notify();
    await flushFrame();
    expect(element.firstElementChild?.getAttribute('data-compact')).toBe('false');
    notify();
    expect(frames.size).toBe(1);
  } finally {
    await act(async () => root.unmount());
    expect(frames.size).toBe(0);
    expect(disconnected).toHaveBeenCalled();
    element.remove();
    widthSpy.mockRestore(); rectSpy.mockRestore(); scrollSpy.mockRestore();
    vi.unstubAllGlobals();
  }
});
