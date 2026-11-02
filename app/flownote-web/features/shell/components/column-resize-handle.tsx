import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';

interface ColumnResizeHandleProps {
  label: string;
  width: number;
  direction?: 1 | -1;
  onResize: (width: number) => void;
  onDraggingChange?: (dragging: boolean) => void;
}

/** Above ordinary chrome (50/60), below modal navigation (100). */
export function ColumnResizeHandle({ label, width, direction = 1, onResize, onDraggingChange }: ColumnResizeHandleProps) {
  const latest = useRef({ onResize, onDraggingChange });
  latest.current = { onResize, onDraggingChange };
  const drag = useRef<{ pointerId: number; x: number; width: number; direction: number; element: HTMLDivElement } | null>(null);

  const stop = useCallback(() => {
    const active = drag.current;
    if (!active) return;
    drag.current = null;
    if (active.element.hasPointerCapture(active.pointerId)) {
      active.element.releasePointerCapture(active.pointerId);
    }
    latest.current.onDraggingChange?.(false);
  }, []);

  useEffect(() => {
    const onVisibilityChange = () => { if (document.hidden) stop(); };
    window.addEventListener('blur', stop);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('blur', stop);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      stop();
    };
  }, [stop]);

  const stopPointer = (event: ReactPointerEvent) => {
    if (drag.current?.pointerId === event.pointerId) stop();
  };

  return <div
    role="separator"
    aria-label={label}
    aria-orientation="vertical"
    aria-valuenow={Math.round(width)}
    tabIndex={0}
    className="absolute inset-y-0 -left-[5px] z-[70] w-[11px] touch-none select-none cursor-col-resize [-webkit-app-region:no-drag] focus-visible:outline-none focus-visible:bg-[var(--brand)]"
    onKeyDown={(event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      event.stopPropagation();
      onResize(width + (event.key === 'ArrowRight' ? 20 : -20) * direction);
    }}
    onPointerDown={(event) => {
      if (event.button !== 0 || !event.isPrimary || drag.current) return;
      event.preventDefault();
      event.stopPropagation();
      // Install capture synchronously: no effect timing gap or iframe event loss.
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { pointerId: event.pointerId, x: event.clientX, width, direction, element: event.currentTarget };
      latest.current.onDraggingChange?.(true);
    }}
    onPointerMove={(event) => {
      const active = drag.current;
      if (!active || active.pointerId !== event.pointerId) return;
      event.preventDefault();
      if (event.buttons === 0) { stop(); return; }
      latest.current.onResize(active.width + (event.clientX - active.x) * active.direction);
    }}
    onPointerUp={stopPointer}
    onPointerCancel={stopPointer}
    onLostPointerCapture={stopPointer}
  />;
}
