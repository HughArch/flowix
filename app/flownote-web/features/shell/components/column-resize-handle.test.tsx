import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ColumnResizeHandle } from './column-resize-handle';

it('captures immediately, follows the active pointer and latest callback, and cleans up interrupted drags', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const first = vi.fn();
  const latest = vi.fn();
  const dragging = vi.fn();
  const render = (onResize = first) => act(() => root.render(<ColumnResizeHandle label="resize" width={300} direction={-1} onResize={onResize} onDraggingChange={dragging} />));
  render();
  const handle = container.firstElementChild as HTMLDivElement;
  let captured = false;
  handle.setPointerCapture = vi.fn(() => { captured = true; });
  handle.hasPointerCapture = vi.fn(() => captured);
  handle.releasePointerCapture = vi.fn(() => { captured = false; });
  const pointer = (type: string, values: Record<string, number | boolean> = {}) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 100, buttons: 1, ...values });
    Object.defineProperties(event, { pointerId: { value: values.pointerId ?? 1 }, isPrimary: { value: true } });
    act(() => handle.dispatchEvent(event));
  };
  try {
    pointer('pointerdown', { button: 2 });
    expect(captured).toBe(false);
    pointer('pointerdown');
    expect(captured).toBe(true);
    expect(dragging).toHaveBeenLastCalledWith(true);
    render(latest);
    pointer('pointermove', { clientX: 80, pointerId: 2 });
    expect(latest).not.toHaveBeenCalled();
    pointer('pointermove', { clientX: 80 });
    expect(latest).toHaveBeenLastCalledWith(320);
    expect(first).not.toHaveBeenCalled();
    pointer('pointercancel');
    expect(captured).toBe(false);
    expect(dragging).toHaveBeenLastCalledWith(false);
    for (const interruption of ['pointerup', 'lostpointercapture', 'blur', 'unmount']) {
      pointer('pointerdown');
      if (interruption === 'blur') act(() => window.dispatchEvent(new Event('blur')));
      else if (interruption === 'unmount') act(() => root.unmount());
      else pointer(interruption);
      expect(captured).toBe(false);
      expect(dragging).toHaveBeenLastCalledWith(false);
    }
  } finally {
    container.remove();
  }
});
