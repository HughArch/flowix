import { act } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { focusWorkspaceHostFromEvent } from './workspace-host-focus';
import { useWorkspaceFocusStore } from '../store/workspace-focus-store';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@shared/ui/context-menu';

afterEach(() => useWorkspaceFocusStore.getState().reset());

it('does not notify subscribers for repeated activation of the current host', () => {
  const onChange = vi.fn();
  const unsubscribe = useWorkspaceFocusStore.subscribe(onChange);
  try {
    useWorkspaceFocusStore.getState().focusHost('main-third');
    expect(onChange).not.toHaveBeenCalled();
    useWorkspaceFocusStore.getState().focusHost('browser-column');
    useWorkspaceFocusStore.getState().focusHost('browser-column');
    expect(onChange).toHaveBeenCalledTimes(1);
  } finally { unsubscribe(); }
});

it('ignores real portal focus/pointer capture while allowing host DOM interaction', async () => {
  const container = document.createElement('div');
  const portal = document.createElement('div');
  document.body.append(container, portal);
  const root = createRoot(container);
  const activate = (event: { currentTarget: HTMLElement; target: EventTarget | null }) => focusWorkspaceHostFromEvent(event, 'main-third');
  try {
    await act(async () => root.render(<div onFocusCapture={activate} onPointerDownCapture={activate}>
      <input data-testid="inside" />
      {createPortal(<input data-testid="portal" />, portal)}
      <ContextMenu><ContextMenuTrigger asChild><div data-testid="card">Card</div></ContextMenuTrigger>
        <ContextMenuContent><ContextMenuItem>Copy</ContextMenuItem></ContextMenuContent>
      </ContextMenu>
    </div>));
    useWorkspaceFocusStore.getState().focusHost('browser-column');
    const popupInput = portal.querySelector<HTMLInputElement>('input')!;
    await act(async () => {
      popupInput.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      popupInput.focus();
    });
    expect(useWorkspaceFocusStore.getState().focusedHostId).toBe('browser-column');
    await act(async () => container.querySelector('[data-testid="card"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    expect(document.activeElement?.getAttribute('role')).toBe('menu');
    expect(useWorkspaceFocusStore.getState().focusedHostId).toBe('browser-column');
    await act(async () => document.querySelector('[role="menuitem"]')!.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(useWorkspaceFocusStore.getState().focusedHostId).toBe('browser-column');
    await act(async () => container.querySelector<HTMLInputElement>('[data-testid="inside"]')!.focus());
    expect(useWorkspaceFocusStore.getState().focusedHostId).toBe('main-third');
  } finally {
    await act(async () => root.unmount());
    container.remove(); portal.remove();
  }
});
