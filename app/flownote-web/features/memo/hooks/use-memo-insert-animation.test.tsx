import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useMemoInsertAnimation } from './use-memo-insert-animation';

let api: ReturnType<typeof useMemoInsertAnimation>;
function Harness() {
  api = useMemoInsertAnimation();
  return null;
}
const container = document.createElement('div');
let root: ReturnType<typeof createRoot>;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  vi.restoreAllMocks();
});

it('animates an offscreen new card on registration without overriding virtual-list scrolling', async () => {
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: false } as MediaQueryList);
  const scroller = document.createElement('div');
  scroller.scrollTop = 12000;
  api.prepareForInsert('new-note');
  api.onListRendered(scroller);
  expect(scroller.scrollTop).toBe(12000);

  const card = document.createElement('div');
  card.getAnimations = () => [];
  card.animate = vi.fn();
  api.registerCard('new-note')(card);
  expect(card.animate).toHaveBeenCalledTimes(1);
  api.onListRendered(scroller);
  expect(card.animate).toHaveBeenCalledTimes(1);
});

it('preserves browsing position when no explicit creation is pending', async () => {
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
  const scroller = document.createElement('div');
  scroller.scrollTop = 12000;
  api.onListRendered(scroller);
  expect(scroller.scrollTop).toBe(12000);
});

it('animates an already mounted card without overriding virtual-list scrolling', async () => {
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: false } as MediaQueryList);
  const scroller = document.createElement('div');
  scroller.scrollTop = 50;
  const card = document.createElement('div');
  card.getAnimations = () => [];
  card.animate = vi.fn();
  api.prepareForInsert('new-note');
  api.registerCard('new-note')(card);
  expect(card.animate).not.toHaveBeenCalled();
  api.onListRendered(scroller);
  expect(scroller.scrollTop).toBe(50);
  expect(card.animate).toHaveBeenCalledTimes(1);
});
