import { act, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSubmenu, ContextMenuTrigger,
} from './context-menu';

let container: HTMLDivElement;
let root: Root;
let action: Mock<() => void>;

async function render(items?: ReactNode) {
  await act(async () => root.render(<>
    <div data-testid="list"><ContextMenu>
      <ContextMenuTrigger asChild><div data-testid="card">Note card</div></ContextMenuTrigger>
      <ContextMenuContent>{items ?? <ContextMenuItem onClick={action}>Copy link</ContextMenuItem>}</ContextMenuContent>
    </ContextMenu></div>
    <div data-testid="editor" contentEditable suppressContentEditableWarning>Body text</div>
    <input data-testid="outside" />
  </>));
}

function element(selector: string) { return document.querySelector<HTMLElement>(selector)!; }
function menu() { return element('[data-flowix-surface="context-menu"]'); }
async function open() {
  await act(async () => element('[data-testid="card"]').dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: 10, clientY: 20,
  })));
}
async function key(target: HTMLElement, value: string) {
  await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })));
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  action = vi.fn();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('context menu focus and scroll ownership', () => {
  it('takes DOM focus without scrolling and returns Escape focus to the card, not the editor', async () => {
    await render();
    const editor = element('[data-testid="editor"]');
    editor.focus();
    const editorFocus = vi.spyOn(editor, 'focus');
    const card = element('[data-testid="card"]');
    const cardFocus = vi.spyOn(card, 'focus');
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    await open();
    expect(document.activeElement).toBe(menu());
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    await key(menu(), 'Escape');
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(card);
    expect(cardFocus).toHaveBeenCalledWith({ preventScroll: true });
    expect(editorFocus).not.toHaveBeenCalled();
  });

  it('executes the first action once despite sibling editor scroll between mousedown and click', async () => {
    await render();
    await open();
    const item = menu().querySelector<HTMLButtonElement>('button')!;
    await act(async () => {
      item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
      element('[data-testid="editor"]').dispatchEvent(new Event('scroll'));
    });
    expect(item.isConnected).toBe(true);
    await act(async () => item.click());
    expect(action).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
  });

  it('does not dismiss when the menu itself scrolls', async () => {
    await render();
    await open();
    await act(async () => menu().dispatchEvent(new Event('scroll')));
    expect(menu()).not.toBeNull();
  });

  it.each(['[data-testid="list"]', 'document'])('dismisses when the trigger moves with %s scrolling', async (target) => {
    await render();
    await open();
    await act(async () => (target === 'document' ? document : element(target)).dispatchEvent(new Event('scroll')));
    expect(menu()).toBeNull();
    expect(action).not.toHaveBeenCalled();
  });

  it('lets outside pointer targets take focus without restoring the editor or card', async () => {
    await render();
    await open();
    const cardFocus = vi.spyOn(element('[data-testid="card"]'), 'focus');
    const outside = element('[data-testid="outside"]');
    await act(async () => {
      outside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      outside.focus();
    });
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(outside);
    expect(cardFocus).not.toHaveBeenCalled();
  });

  it('preserves focus explicitly handed to a command destination', async () => {
    await render(<ContextMenuItem onClick={() => element('[data-testid="outside"]').focus()}>Rename</ContextMenuItem>);
    await open();
    const cardFocus = vi.spyOn(element('[data-testid="card"]'), 'focus');
    await act(async () => menu().querySelector<HTMLButtonElement>('button')!.click());
    expect(document.activeElement).toBe(element('[data-testid="outside"]'));
    expect(cardFocus).not.toHaveBeenCalled();
  });

  it('hands focus to a rename dialog mounted by the same action that closes the menu', async () => {
    // Keep the dialog owner mounted outside ContextMenuContent's conditional DOM.
    function RenameHarness() {
      const [renaming, setRenaming] = useState(false);
      return <><ContextMenu><ContextMenuTrigger asChild><div data-testid="card">Card</div></ContextMenuTrigger>
        <ContextMenuContent><ContextMenuItem onClick={() => setRenaming(true)}>Rename</ContextMenuItem></ContextMenuContent>
      </ContextMenu>{renaming && createPortal(<input autoFocus data-testid="rename" />, document.body)}</>;
    }
    await act(async () => root.render(<RenameHarness />));
    await open();
    await act(async () => menu().querySelector<HTMLButtonElement>('button')!.click());
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(element('[data-testid="rename"]'));
  });

  it('navigates enabled items and submenus without scrolling or closing the parent', async () => {
    await render(<>
      <ContextMenuItem disabled>Disabled</ContextMenuItem>
      <ContextMenuItem onClick={action}>Copy</ContextMenuItem>
      <ContextMenuSubmenu label="More"><ContextMenuItem onClick={action}>Nested copy</ContextMenuItem></ContextMenuSubmenu>
    </>);
    await open();
    await key(menu(), 'ArrowDown');
    expect(document.activeElement?.textContent).toBe('Copy');
    await key(menu(), 'End');
    const trigger = document.activeElement as HTMLElement;
    expect(trigger.textContent).toBe('More');
    await key(trigger, 'ArrowRight');
    const submenu = element('[data-context-menu-submenu]');
    expect(submenu.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.textContent).toBe('Nested copy');
    await act(async () => submenu.dispatchEvent(new Event('scroll')));
    expect(menu()).not.toBeNull();
    await key(document.activeElement as HTMLElement, 'Escape');
    expect(element('[data-context-menu-submenu]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(menu()).not.toBeNull();
    await key(trigger, 'Escape');
    expect(menu()).toBeNull();
  });

  it('keeps the menu open for explicit keepOpenOnClick actions', async () => {
    await render(<ContextMenuItem onClick={action} keepOpenOnClick>Toggle</ContextMenuItem>);
    await open();
    await act(async () => menu().querySelector<HTMLButtonElement>('button')!.click());
    expect(action).toHaveBeenCalledTimes(1);
    expect(menu()).not.toBeNull();
  });

  it('executes the first nested copy action once while the sibling editor scrolls', async () => {
    await render(<ContextMenuSubmenu label="Copy"><ContextMenuItem onClick={action}>Copy link</ContextMenuItem></ContextMenuSubmenu>);
    await open();
    await key(menu(), 'ArrowDown');
    await key(document.activeElement as HTMLElement, 'ArrowRight');
    const item = element('[data-context-menu-submenu] [role="menuitem"]');
    await act(async () => {
      item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      element('[data-testid="editor"]').dispatchEvent(new Event('scroll'));
    });
    expect(item.isConnected).toBe(true);
    await act(async () => item.click());
    expect(action).toHaveBeenCalledOnce();
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(element('[data-testid="card"]'));
  });
});
