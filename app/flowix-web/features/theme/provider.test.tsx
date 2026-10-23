import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ theme: 'mist', member: true, apply: vi.fn() }));
vi.mock('@features/preferences/public/runtime-api', () => ({ useAppTheme: () => state.theme }));
vi.mock('@features/preferences/public/membership', () => ({ useMembershipAccess: () => ({ active: state.member }) }));
vi.mock('@platform/tauri/client', () => ({ windows: { applyWindowTheme: state.apply } }));
import { ThemeProvider } from './provider';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  state.theme = 'mist';
  state.member = true;
  state.apply.mockReset();
  localStorage.clear();
  delete document.documentElement.dataset.windowMaterial;
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
const render = () => act(async () => root.render(createElement(ThemeProvider, { children: null })));

it('reflects applied native material and clears it when leaving Mist', async () => {
  state.apply.mockResolvedValueOnce('vibrancy').mockResolvedValueOnce('none');
  await render();
  expect(document.documentElement.dataset.windowMaterial).toBe('vibrancy');
  expect(localStorage.getItem('flowix-window-material')).toBe('vibrancy');
  state.theme = 'dark';
  await render();
  expect(state.apply).toHaveBeenLastCalledWith('dark');
  expect(document.documentElement.dataset.windowMaterial).toBeUndefined();
  expect(localStorage.getItem('flowix-window-material')).toBeNull();
});

it('ignores an older IPC completion after the theme changes', async () => {
  let finish!: (material: string) => void;
  state.apply.mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce('none');
  await render();
  state.theme = 'rock';
  await render();
  await act(async () => finish('vibrancy'));
  expect(document.documentElement.dataset.windowMaterial).toBeUndefined();
});

it('applies a solid fallback when membership does not allow Mist', async () => {
  state.member = false;
  state.apply.mockResolvedValue('none');
  await render();
  expect(state.apply).toHaveBeenCalledWith('rock');
  expect(document.documentElement.dataset.windowMaterial).toBeUndefined();
});
