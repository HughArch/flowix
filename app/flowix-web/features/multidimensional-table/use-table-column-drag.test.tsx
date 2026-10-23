import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { moveTableColumn, useTableColumnDrag } from './use-table-column-drag';

it('moves mixed fields while retaining hidden fields and fixing the primary column', () => {
  const ids = ['primary', 'a', 'hidden', '__note_tags__'];
  expect(moveTableColumn(ids, '__note_tags__', 'a', false, 'primary')).toEqual(['primary', '__note_tags__', 'a', 'hidden']);
  expect(moveTableColumn(ids, 'primary', 'a', true, 'primary')).toEqual(ids);
  expect(moveTableColumn(ids, 'a', 'primary', false, 'primary')).toEqual(ids);
});

it('follows the pointer, previews the destination and saves only on a valid release', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const save = vi.fn(async () => true);
  const click = vi.fn();
  function Harness() {
    const tableRef = useRef<HTMLTableElement>(null);
    const scrollerRef = useRef<HTMLDivElement>(null);
    const drag = useTableColumnDrag({ tableRef, scrollerRef, ids: ['primary', 'a', 'b'], primaryId: 'primary', disabled: false, onReorder: save, onStart: () => {} });
    return <div ref={scrollerRef}><table ref={tableRef} onPointerDown={drag.onPointerDown} onClickCapture={drag.onClickCapture}><thead><tr>{drag.order.map((id) => <th key={id} data-column-field-id={id} data-preview={drag.draggedId === id}><button className="multidimensional-table__header-trigger" onClick={click}>{id}</button></th>)}</tr></thead></table></div>;
  }
  const pointer = (target: EventTarget, type: string, x: number, y = 15) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, { pointerId: { value: 1 }, button: { value: 0 }, clientX: { value: x }, clientY: { value: y } });
    target.dispatchEvent(event);
  };
  const widths: Record<string, number> = { primary: 100, a: 100, b: 100 };
  const order = () => [...container.querySelectorAll<HTMLElement>('th')].map((node) => node.dataset.columnFieldId);
  try {
    act(() => root.render(<Harness />));
    container.firstElementChild!.getBoundingClientRect = () => ({ left: 0, right: 300, top: 0, bottom: 300 }) as DOMRect;
    container.querySelector('thead')!.getBoundingClientRect = () => ({ left: 0, right: 300, top: 0, bottom: 36 }) as DOMRect;
    container.querySelectorAll('th').forEach((node) => {
      node.style.fontSize = '14px';
      node.style.lineHeight = '20px';
      node.style.setProperty('--multidimensional-table-content-inset', '8px');
      node.getBoundingClientRect = () => {
        const siblings = [...node.parentElement!.children] as HTMLElement[];
        const index = siblings.indexOf(node);
        const left = siblings.slice(0, index).reduce((sum, item) => sum + widths[item.dataset.columnFieldId!], 0) - container.firstElementChild!.scrollLeft;
        const width = widths[node.dataset.columnFieldId!];
        return { left, right: left + width, width, top: 0, bottom: 36 } as DOMRect;
      };
    });
    const button = container.querySelector<HTMLButtonElement>('[data-column-field-id="b"] button')!;
    act(() => pointer(button, 'pointerdown', 220));
    act(() => pointer(window, 'pointermove', 222));
    expect(document.querySelector('.multidimensional-table__column-drag-floating')).toBeNull();
    act(() => pointer(window, 'pointermove', 110));
    expect(order()).toEqual(['primary', 'b', 'a']);
    expect(container.querySelector('[data-column-field-id="b"]')?.getAttribute('data-preview')).toBe('true');
    expect((document.querySelector('.multidimensional-table__column-drag-floating') as HTMLElement).style.transform).toBe('translate(90px, 0px)');
    const floating = document.querySelector<HTMLElement>('.multidimensional-table__column-drag-floating')!;
    expect(floating.style.fontSize).toBe('14px');
    expect(floating.style.lineHeight).toBe('20px');
    expect(floating.style.getPropertyValue('--multidimensional-table-content-inset')).toBe('8px');
    expect(save).not.toHaveBeenCalled();
    // Moving within the preview column must not switch back at A's old midpoint.
    act(() => pointer(window, 'pointermove', 180));
    expect(order()).toEqual(['primary', 'b', 'a']);
    act(() => pointer(window, 'pointermove', 220));
    expect(order()).toEqual(['primary', 'b', 'a']);
    act(() => pointer(window, 'pointermove', 270));
    expect(order()).toEqual(['primary', 'a', 'b']);
    act(() => pointer(window, 'pointermove', 110));
    expect(order()).toEqual(['primary', 'b', 'a']);
    await act(async () => pointer(window, 'pointerup', 110));
    expect(save).toHaveBeenCalledWith(['primary', 'b', 'a']);
    expect(document.querySelector('.multidimensional-table__column-drag-floating')).toBeNull();
    act(() => button.click());
    expect(click).not.toHaveBeenCalled();
    save.mockClear();
    act(() => pointer(button, 'pointerdown', 220));
    act(() => pointer(window, 'pointermove', 110));
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    await act(async () => pointer(window, 'pointerup', 110));
    expect(save).not.toHaveBeenCalled();
    expect(order()).toEqual(['primary', 'a', 'b']);
    act(() => pointer(button, 'pointerdown', 220));
    act(() => pointer(window, 'pointermove', 110));
    await act(async () => pointer(window, 'pointerup', 110, 200));
    expect(save).not.toHaveBeenCalled();
    expect(order()).toEqual(['primary', 'a', 'b']);
    // Unequal widths and a scrolled viewport use current header centres too.
    widths.a = 180;
    widths.b = 60;
    container.firstElementChild!.scrollLeft = 40;
    act(() => pointer(button, 'pointerdown', 260));
    act(() => pointer(window, 'pointermove', 100));
    expect(order()).toEqual(['primary', 'b', 'a']);
    expect(document.querySelector<HTMLElement>('.multidimensional-table__column-drag-floating')!.style.width).toBe('60px');
    act(() => pointer(window, 'pointermove', 180));
    expect(order()).toEqual(['primary', 'b', 'a']);
    act(() => pointer(window, 'pointermove', 230));
    expect(order()).toEqual(['primary', 'a', 'b']);
    act(() => pointer(window, 'pointercancel', 230));
    expect(save).not.toHaveBeenCalled();
    expect(document.querySelector('.multidimensional-table__column-drag-floating')).toBeNull();
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
