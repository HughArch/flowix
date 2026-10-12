import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { TableFieldList } from './table-field-list';

it('previews handle dragging and commits on release, keeping the primary field fixed', async () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const onReorder = vi.fn();
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  const pointer = (target: EventTarget, type: string, y: number) => {
    const event = new Event(type, { bubbles: true });
    Object.defineProperties(event, { pointerId: { value: 1 }, button: { value: 0 }, clientX: { value: 10 }, clientY: { value: y } });
    target.dispatchEvent(event);
  };
  try {
    act(() => root.render(<TableFieldList ids={['primary', 'a', 'b']} primaryId="primary" disabled={false} label={(id) => id} renderField={(id) => id} onReorder={onReorder} />));
    const list = container.firstElementChild as HTMLElement;
    list.getBoundingClientRect = () => ({ left: 0, right: 100, top: 0, bottom: 100 }) as DOMRect;
    for (const row of container.querySelectorAll<HTMLElement>('[data-field-id]')) {
      row.getBoundingClientRect = () => {
        const index = [...list.children].indexOf(row);
        return { top: index * 32, height: 32, left: 0 } as DOMRect;
      };
    }
    expect(container.querySelector<HTMLButtonElement>('[data-field-id="primary"] button')?.disabled).toBe(true);
    const handle = container.querySelector<HTMLButtonElement>('[data-field-id="b"] button')!;
    act(() => pointer(handle, 'pointerdown', 80));
    act(() => pointer(window, 'pointermove', 35));
    expect([...list.children].map((row) => (row as HTMLElement).dataset.fieldId)).toEqual(['primary', 'b', 'a']);
    expect(onReorder).not.toHaveBeenCalled();
    await act(async () => pointer(window, 'pointerup', 35));
    expect(onReorder).toHaveBeenCalledWith(['primary', 'b', 'a']);
  } finally { act(() => root.unmount()); vi.unstubAllGlobals(); }
});
