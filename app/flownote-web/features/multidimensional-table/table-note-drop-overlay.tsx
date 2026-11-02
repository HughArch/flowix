import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '@/lib/i18n';

export function TableNoteDropOverlay({ active, dropAreaRef }: {
  active: boolean;
  dropAreaRef: { current: HTMLElement | null };
}) {
  const { t } = useI18n();
  const [bounds, setBounds] = useState<{ top: number; left: number; width: number; height: number } | null>(null);

  useEffect(() => {
    if (!active) {
      setBounds(null);
      return;
    }
    const updateBounds = () => {
      const area = dropAreaRef.current;
      if (!area) {
        setBounds(null);
        return;
      }
      const rect = area.getBoundingClientRect();
      setBounds({ top: rect.top, left: rect.left, width: rect.width, height: rect.height });
    };
    updateBounds();
    window.addEventListener('resize', updateBounds);
    window.addEventListener('scroll', updateBounds, true);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateBounds);
    if (dropAreaRef.current) observer?.observe(dropAreaRef.current);
    return () => {
      window.removeEventListener('resize', updateBounds);
      window.removeEventListener('scroll', updateBounds, true);
      observer?.disconnect();
    };
  }, [active, dropAreaRef]);

  if (!active || !bounds || bounds.width <= 0 || bounds.height <= 0) return null;
  return createPortal(<div
    aria-live="polite"
    className="pointer-events-none z-[80] flex items-center justify-center bg-[color-mix(in_oklch,var(--document-bg)_58%,transparent)] backdrop-blur-[1px]"
    style={{ position: 'fixed', top: bounds.top, left: bounds.left, width: bounds.width, height: bounds.height }}
  >
    <span className="text-sm font-medium text-[var(--foreground)]">{t('multidimensionalTable.dropOverlayHint')}</span>
  </div>, document.body);
}
