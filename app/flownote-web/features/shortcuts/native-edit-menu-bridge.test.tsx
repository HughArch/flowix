import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NativeEditMenuBridge } from './native-edit-menu-bridge';

const mocks = vi.hoisted(() => ({
  actionRun: vi.fn(),
  getAction: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  execCommand: vi.fn(),
  listeners: new Map<string, () => void>(),
}));

vi.mock('@/lib/shortcuts/registry', () => ({
  getAction: mocks.getAction,
}));
vi.mock('@/lib/shortcuts/platform', () => ({
  getPlatform: () => 'mac',
}));
vi.mock('@platform/tauri/event-bus', () => ({
  subscribe: mocks.subscribe,
}));

describe('NativeEditMenuBridge', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    mocks.actionRun.mockReset();
    mocks.getAction.mockReset().mockReturnValue({ run: mocks.actionRun });
    mocks.unsubscribe.mockReset();
    mocks.execCommand.mockReset().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: mocks.execCommand,
    });
    mocks.listeners.clear();
    mocks.subscribe.mockReset().mockImplementation((event: string, listener: () => void) => {
      mocks.listeners.set(event, listener);
      return mocks.unsubscribe;
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<NativeEditMenuBridge />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('dispatches the editor select-all action with native menu context', () => {
    mocks.listeners.get('flownote://editor-select-all')?.();

    expect(mocks.actionRun).toHaveBeenCalledWith({
      scope: 'editor',
      source: 'menu',
      platform: 'mac',
    });
  });

  it.each(['input', 'textarea'] as const)('selects a focused %s without dispatching the editor action', (tag) => {
    const field = document.createElement(tag);
    field.value = 'Flownote';
    document.body.appendChild(field);
    const select = vi.spyOn(field, 'select');
    field.focus();

    mocks.listeners.get('flownote://editor-select-all')?.();

    expect(select).toHaveBeenCalledOnce();
    expect(mocks.actionRun).not.toHaveBeenCalled();
    field.remove();
  });

  it('is a safe no-op when the action is unavailable', () => {
    mocks.getAction.mockReturnValue(undefined);

    expect(() => mocks.listeners.get('flownote://editor-select-all')?.()).not.toThrow();
    expect(mocks.actionRun).not.toHaveBeenCalled();
  });

  it.each([
    ['flownote://editor-undo', 'editor.undo'],
    ['flownote://editor-redo', 'editor.redo'],
  ])('dispatches %s to the focused editor action', (event, actionId) => {
    mocks.listeners.get(event)?.();

    expect(mocks.getAction).toHaveBeenCalledWith(actionId);
    expect(mocks.actionRun).toHaveBeenCalledWith({
      scope: 'editor',
      source: 'menu',
      platform: 'mac',
    });
  });

  it.each([
    ['flownote://editor-undo', 'undo'],
    ['flownote://editor-redo', 'redo'],
  ])('keeps native %s behavior for focused text fields', (event, command) => {
    const field = document.createElement('textarea');
    document.body.appendChild(field);
    field.focus();
    mocks.listeners.get(event)?.();

    expect(mocks.execCommand).toHaveBeenCalledWith(command);
    expect(mocks.actionRun).not.toHaveBeenCalled();
    field.remove();
  });

  it('keeps undo native for a focused contenteditable title', () => {
    const title = document.createElement('div');
    title.className = 'memo-title-editor--document-selection';
    title.contentEditable = 'plaintext-only';
    title.tabIndex = 0;
    Object.defineProperty(title, 'isContentEditable', { configurable: true, value: true });
    document.body.appendChild(title);
    title.focus();

    mocks.listeners.get('flownote://editor-undo')?.();

    expect(mocks.execCommand).toHaveBeenCalledWith('undo');
    expect(mocks.actionRun).not.toHaveBeenCalled();
    title.remove();
  });

  it('routes a non-title contenteditable editor to the editor action', () => {
    const editor = document.createElement('div');
    editor.className = 'ProseMirror';
    editor.contentEditable = 'true';
    Object.defineProperty(editor, 'isContentEditable', { configurable: true, value: true });
    editor.tabIndex = 0;
    document.body.appendChild(editor);
    editor.focus();

    mocks.listeners.get('flownote://editor-undo')?.();

    expect(mocks.getAction).toHaveBeenCalledWith('editor.undo');
    expect(mocks.actionRun).toHaveBeenCalledWith({
      scope: 'editor',
      source: 'menu',
      platform: 'mac',
    });
    expect(mocks.execCommand).not.toHaveBeenCalled();
    editor.remove();
  });

  it('unsubscribes from the native event when unmounted', async () => {
    await act(async () => root.unmount());

    expect(mocks.unsubscribe).toHaveBeenCalledTimes(3);
    root = createRoot(container);
  });
});
