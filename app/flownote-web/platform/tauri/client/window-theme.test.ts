import { beforeEach, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@platform/tauri/core', () => ({ invoke }));
import { applyWindowTheme } from './window-theme';

beforeEach(() => invoke.mockReset());

it('waits for native completion so the last selected theme wins', async () => {
  const completed: string[] = [];
  let completeMist!: () => void;
  invoke.mockImplementationOnce(() => new Promise(resolve => {
    completeMist = () => {
      completed.push('mist');
      resolve('vibrancy');
    };
  })).mockImplementationOnce(async () => {
    completed.push('rock');
    return 'none';
  });

  const mist = applyWindowTheme('mist');
  const rock = applyWindowTheme('rock');
  await Promise.resolve();
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenLastCalledWith('apply_window_theme', { theme: 'mist' });
  completeMist();
  await expect(mist).resolves.toBe('vibrancy');
  await expect(rock).resolves.toBe('none');
  expect(completed).toEqual(['mist', 'rock']);
  expect(invoke).toHaveBeenLastCalledWith('apply_window_theme', { theme: 'rock' });
});

it('continues applying newer themes after an IPC failure', async () => {
  invoke.mockRejectedValueOnce(new Error('Window unavailable')).mockResolvedValueOnce('none');
  const mist = applyWindowTheme('mist');
  const dark = applyWindowTheme('dark');
  await expect(mist).rejects.toThrow('Window unavailable');
  await expect(dark).resolves.toBe('none');
  expect(invoke).toHaveBeenLastCalledWith('apply_window_theme', { theme: 'dark' });
});
