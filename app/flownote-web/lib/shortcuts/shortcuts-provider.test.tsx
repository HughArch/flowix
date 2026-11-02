import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ShortcutsProvider } from './shortcuts-provider';
import { defineAction } from './registry';

const run = vi.fn();
defineAction({ id: 'test.startup-shortcut', titleKey: 'error.retry', group: 'test', scope: 'window',
  defaultBinding: { mac: 'F8', windows: 'F8', linux: 'F8' }, run });

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  run.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
function pressKey(key = 'F8') {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  document.body.dispatchEvent(event);
  return event;
}

it('suspends actions until enabled, then resumes without remounting the workbench', async () => {
  const mounted = vi.fn();
  function Workbench() {
    useEffect(mounted, []);
    return <button>business action</button>;
  }
  const render = (enabled: boolean) => root.render(<ShortcutsProvider overrides={{}} enabled={enabled}><Workbench /></ShortcutsProvider>);
  await act(async () => render(false));
  expect(pressKey().defaultPrevented).toBe(false);
  expect(run).not.toHaveBeenCalled();
  await act(async () => render(true));
  expect(pressKey().defaultPrevented).toBe(true);
  expect(run).toHaveBeenCalledTimes(1);
  expect(mounted).toHaveBeenCalledTimes(1);
  await act(async () => render(false));
  pressKey();
  expect(run).toHaveBeenCalledTimes(1);
});

it('keeps shortcuts enabled by default and leaves native window accelerators alone', async () => {
  await act(async () => root.render(<ShortcutsProvider overrides={{}}><div /></ShortcutsProvider>));
  pressKey();
  expect(run).toHaveBeenCalledTimes(1);
  const close = new KeyboardEvent('keydown', { key: 'F4', altKey: true, bubbles: true, cancelable: true });
  document.body.dispatchEvent(close);
  expect(close.defaultPrevented).toBe(false);
});
