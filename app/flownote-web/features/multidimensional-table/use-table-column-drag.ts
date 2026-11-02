import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent, type RefObject } from 'react';

export function moveTableColumn(ids: readonly string[], source: string, target: string, after: boolean, primaryId?: string): string[] {
  if (source === primaryId || target === primaryId || source === target || !ids.includes(source) || !ids.includes(target)) return [...ids];
  const next = ids.filter((id) => id !== source);
  next.splice(next.indexOf(target) + Number(after), 0, source);
  return next;
}

/** Header dragging shares the dataset order with the field manager, including hidden fields. */
export function useTableColumnDrag({ tableRef, scrollerRef, ids, primaryId, disabled, onReorder, onStart }: {
  tableRef: RefObject<HTMLTableElement | null>;
  scrollerRef: RefObject<HTMLDivElement | null>;
  ids: readonly string[];
  primaryId?: string;
  disabled: boolean;
  onReorder: (ids: string[]) => Promise<unknown>;
  onStart: () => void;
}) {
  const [preview, setPreview] = useState<string[] | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const latest = useRef({ ids, primaryId, disabled, onReorder, onStart });
  latest.current = { ids, primaryId, disabled, onReorder, onStart };
  const session = useRef<{
    id: string; pointer: number; x: number; y: number; active: boolean;
    header: HTMLElement; offsetX: number; offsetY: number;
    next: string[] | null; floating: HTMLElement | null;
  } | null>(null);
  const suppressClick = useRef(false);

  useEffect(() => {
    let frame = 0;
    let pointerX = 0;
    let pointerY = 0;
    const clear = () => {
      cancelAnimationFrame(frame);
      session.current?.floating?.remove();
      session.current = null;
      setPreview(null);
      setDraggedId(null);
    };
    const update = () => {
      const drag = session.current;
      const table = tableRef.current;
      if (!drag?.active) return;
      if (!table || latest.current.disabled || latest.current.ids.join('\0') !== dragIds.join('\0')) { clear(); return; }
      if (drag.floating) drag.floating.style.transform = `translate(${pointerX - drag.offsetX}px, ${pointerY - drag.offsetY}px)`;
      const bounds = table.tHead?.getBoundingClientRect();
      const viewport = scrollerRef.current?.getBoundingClientRect();
      const valid = bounds && pointerY >= bounds.top - 24 && pointerY <= bounds.bottom + 24
        && (!viewport || (pointerX >= viewport.left && pointerX <= viewport.right));
      let next: string[] | null = null;
      if (valid) {
        // Read the preview layout, including horizontal scrolling. Keep the current
        // slot until the pointer crosses a neighbour's centre to avoid oscillation.
        next = drag.next ?? [...latest.current.ids];
        const headers = [...table.querySelectorAll<HTMLElement>('th[data-column-field-id]')];
        const sourceIndex = headers.indexOf(drag.header);
        const sourceBounds = drag.header.getBoundingClientRect();
        const movingLeft = pointerX < sourceBounds.left;
        const movingRight = pointerX > sourceBounds.right;
        const crossed = headers.filter((header, index) => {
          if (header === drag.header || header.dataset.columnFieldId === latest.current.primaryId) return false;
          const rect = header.getBoundingClientRect();
          const centre = (rect.left + rect.right) / 2;
          return movingLeft && index < sourceIndex && pointerX < centre
            || movingRight && index > sourceIndex && pointerX > centre;
        });
        const target = movingLeft ? crossed[0] : crossed[crossed.length - 1];
        if (target) next = moveTableColumn(next, drag.id, target.dataset.columnFieldId!, movingRight, latest.current.primaryId);
      }
      if (next?.join('\0') !== drag.next?.join('\0')) { drag.next = next; setPreview(next); }
    };
    let dragIds: readonly string[] = [];
    const tick = () => {
      const drag = session.current;
      if (!drag?.active) return;
      const scroller = scrollerRef.current;
      const bounds = scroller?.getBoundingClientRect();
      if (scroller && bounds && pointerY >= bounds.top && pointerY <= bounds.bottom && pointerX >= bounds.left && pointerX <= bounds.right) {
        const delta = pointerX < bounds.left + 40 ? -12 : pointerX > bounds.right - 40 ? 12 : 0;
        if (delta) scroller.scrollLeft += delta;
      }
      update();
      if (session.current?.active) frame = requestAnimationFrame(tick);
    };
    const move = (event: PointerEvent) => {
      const drag = session.current;
      if (!drag || drag.pointer !== event.pointerId) return;
      if (latest.current.disabled) { clear(); return; }
      pointerX = event.clientX; pointerY = event.clientY;
      if (!drag.active) {
        if (Math.hypot(pointerX - drag.x, pointerY - drag.y) < 6) return;
        drag.active = true;
        dragIds = [...latest.current.ids];
        suppressClick.current = true;
        const floating = window.document.createElement('div');
        floating.className = 'multidimensional-table__column-drag-floating';
        floating.setAttribute('aria-hidden', 'true');
        const clone = drag.header.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
        floating.append(...Array.from(clone.childNodes));
        const style = getComputedStyle(drag.header);
        floating.style.fontFamily = style.fontFamily;
        floating.style.fontSize = style.fontSize;
        floating.style.fontWeight = style.fontWeight;
        floating.style.lineHeight = style.lineHeight;
        floating.style.letterSpacing = style.letterSpacing;
        floating.style.setProperty('--multidimensional-table-content-inset', style.getPropertyValue('--multidimensional-table-content-inset') || '8px');
        floating.inert = true;
        floating.style.width = `${drag.header.getBoundingClientRect().width}px`;
        window.document.body.append(floating);
        drag.floating = floating;
        setDraggedId(drag.id);
        latest.current.onStart();
        frame = requestAnimationFrame(tick);
      }
      event.preventDefault();
      update();
    };
    const up = (event: PointerEvent) => {
      const drag = session.current;
      if (!drag || drag.pointer !== event.pointerId) return;
      pointerX = event.clientX; pointerY = event.clientY;
      update();
      const next = session.current?.next;
      const commit = drag.active && next && !latest.current.disabled && next.join('\0') !== latest.current.ids.join('\0');
      clear();
      if (commit && next) {
        setPreview(next);
        void latest.current.onReorder(next).catch(() => undefined).finally(() => setPreview(null));
      }
    };
    const cancel = (event: PointerEvent) => { if (session.current?.pointer === event.pointerId) clear(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') clear(); };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key);
    window.addEventListener('blur', clear);
    return () => {
      clear();
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key);
      window.removeEventListener('blur', clear);
    };
  }, [tableRef, scrollerRef]);

  return {
    order: preview ?? ids,
    draggedId,
    onPointerDown: (event: ReactPointerEvent<HTMLTableElement>) => {
      suppressClick.current = false;
      if (disabled || event.button !== 0 || !(event.target instanceof Element)) return;
      const header = event.target.closest<HTMLElement>('th[data-column-field-id]');
      if (!header || header.dataset.columnFieldId === primaryId || !event.target.closest('.multidimensional-table__header-trigger')) return;
      const rect = header.getBoundingClientRect();
      session.current = {
        id: header.dataset.columnFieldId!, pointer: event.pointerId, x: event.clientX, y: event.clientY,
        active: false, header, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top,
        next: null, floating: null,
      };
    },
    onClickCapture: (event: ReactMouseEvent<HTMLTableElement>) => {
      if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false; }
    },
  };
}
