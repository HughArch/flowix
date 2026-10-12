import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { GripVertical } from 'lucide-react';

function move(ids: string[], source: string, target: string, after: boolean): string[] {
  if (source === target || !ids.includes(source) || !ids.includes(target)) return ids;
  const next = ids.filter((id) => id !== source);
  next.splice(next.indexOf(target) + Number(after), 0, source);
  return next;
}

export function TableFieldList({ ids, primaryId, activeId, disabled, label, renderField, onReorder, itemTypeLabel = '字段' }: {
  ids: string[]; primaryId?: string; activeId?: string | null; disabled: boolean; itemTypeLabel?: string;
  label: (id: string) => string; renderField: (id: string) => ReactNode;
  onReorder: (ids: string[]) => void | Promise<void>;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const session = useRef<{ id: string; pointer: number; x: number; y: number; active: boolean } | null>(null);
  const target = useRef<{ id: string; after: boolean } | null>(null);
  const previousRects = useRef<Map<string, DOMRect> | null>(null);
  const [dragged, setDragged] = useState<string | null>(null);
  const [preview, setPreview] = useState<string[] | null>(null);
  const current = useRef({ ids, disabled, onReorder });
  current.current = { ids, disabled, onReorder };
  const capture = () => {
    previousRects.current = new Map([...listRef.current?.querySelectorAll<HTMLElement>('[data-field-id]') ?? []].map((row) => [row.dataset.fieldId!, row.getBoundingClientRect()]));
  };
  useLayoutEffect(() => {
    const rects = previousRects.current;
    previousRects.current = null;
    if (!rects || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    listRef.current?.querySelectorAll<HTMLElement>('[data-field-id]').forEach((row) => {
      const previous = rects.get(row.dataset.fieldId!);
      if (!previous) return;
      const dy = previous.top - row.getBoundingClientRect().top;
      if (Math.abs(dy) < 1) return;
      row.getAnimations().forEach((animation) => animation.cancel());
      row.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], { duration: 180, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
    });
  }, [preview, ids]);
  useEffect(() => {
    const cancel = () => { capture(); session.current = null; target.current = null; setDragged(null); setPreview(null); };
    const onMove = (event: PointerEvent) => {
      const drag = session.current;
      if (!drag || drag.pointer !== event.pointerId || current.current.disabled) return;
      if (!drag.active) {
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return;
        drag.active = true; setDragged(drag.id);
      }
      const bounds = listRef.current?.getBoundingClientRect();
      if (!bounds || event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
        if (target.current) { capture(); target.current = null; setPreview(null); }
        return;
      }
      const rows = [...listRef.current?.querySelectorAll<HTMLElement>('[data-field-id]') ?? []].filter((row) => row.dataset.fieldId !== drag.id && row.dataset.fieldId !== primaryId);
      const row = rows.find((item) => event.clientY < item.getBoundingClientRect().top + item.getBoundingClientRect().height / 2);
      const next = row ? { id: row.dataset.fieldId!, after: false } : rows.length ? { id: rows[rows.length - 1].dataset.fieldId!, after: true } : null;
      if (target.current?.id === next?.id && target.current?.after === next?.after) return;
      capture(); target.current = next;
      setPreview(next ? move(current.current.ids, drag.id, next.id, next.after) : null);
    };
    const onUp = (event: PointerEvent) => {
      const drag = session.current;
      if (!drag || drag.pointer !== event.pointerId) return;
      const drop = target.current;
      const next = drag.active && drop && !current.current.disabled ? move(current.current.ids, drag.id, drop.id, drop.after) : null;
      cancel();
      if (next && next.some((id, index) => id !== current.current.ids[index])) {
        setPreview(next);
        void Promise.resolve(current.current.onReorder(next)).finally(() => setPreview(null));
      }
    };
    const onCancel = (event: PointerEvent) => { if (session.current?.pointer === event.pointerId) cancel(); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel(); };
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel); window.addEventListener('keydown', onKey); window.addEventListener('blur', cancel);
    return () => { session.current = null; window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); window.removeEventListener('pointercancel', onCancel); window.removeEventListener('keydown', onKey); window.removeEventListener('blur', cancel); };
  }, [primaryId]);
  return <div ref={listRef} className="min-w-0 space-y-0.5">{(preview ?? ids).map((id) => <div key={id} data-field-id={id} data-table-field-item data-active={activeId === id || undefined} className={`flex h-8 min-w-0 items-center rounded-lg hover:bg-[var(--hover-bg)] data-[active=true]:bg-[var(--hover-bg)] ${dragged === id ? 'opacity-50' : ''}`}>
    <button type="button" title={id === primaryId ? '笔记名称固定在首列' : `拖动调整${itemTypeLabel}顺序`} aria-label={`拖动调整${itemTypeLabel}顺序 ${label(id)}`} disabled={disabled || id === primaryId}
      className="ml-1 flex h-6 w-6 shrink-0 cursor-grab touch-none items-center justify-center text-[var(--muted-foreground)] active:cursor-grabbing disabled:cursor-default disabled:opacity-40"
      onClick={(event) => event.stopPropagation()} onPointerDown={(event) => {
        if (event.button !== 0 || disabled || id === primaryId) return;
        event.preventDefault(); event.stopPropagation();
        session.current = { id, pointer: event.pointerId, x: event.clientX, y: event.clientY, active: false };
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Window listeners finish the drag. */ }
      }}><GripVertical className="h-4 w-4" aria-hidden="true" /></button>
    <div className="min-w-0 flex-1">{renderField(id)}</div>
  </div>)}</div>;
}
