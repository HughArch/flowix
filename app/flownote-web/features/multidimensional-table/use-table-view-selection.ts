import { useCallback, useEffect, useRef, useState } from 'react';
import type { MultidimensionalTableDocument } from './model';
import { rememberTableView, resolveTableView } from './view-selection';

interface Options {
  document: MultidimensionalTableDocument | null;
  initialViewId?: string | null;
  editable: boolean;
  saving: boolean;
  save: (document: MultidimensionalTableDocument) => Promise<boolean>;
  onActiveViewChange?: (viewId: string) => void;
}

/** Restoring a view never writes. Only an explicit selection changes the file. */
export function useTableViewSelection({ document, initialViewId, editable, saving, save, onActiveViewChange }: Options) {
  const [activeViewId, setActiveViewId] = useState<string | null>(initialViewId ?? null);
  const previousInitialIdRef = useRef(initialViewId ?? null);
  const selectionSavingRef = useRef(false);

  useEffect(() => {
    const requestedId = initialViewId ?? null;
    const changed = previousInitialIdRef.current !== requestedId;
    previousInitialIdRef.current = requestedId;
    setActiveViewId((current) => {
      if (!document) return null;
      if (!changed && document.views.items.some((view) => view.id === current)) return current;
      return resolveTableView(document, requestedId)?.id ?? null;
    });
  }, [document, initialViewId]);

  const activateView = useCallback((viewId: string) => {
    setActiveViewId(viewId);
    if (editable) onActiveViewChange?.(viewId);
  }, [editable, onActiveViewChange]);

  const selectView = useCallback(async (viewId: string) => {
    if (!document || saving || selectionSavingRef.current || !document.views.items.some((view) => view.id === viewId)) return;
    activateView(viewId);
    if (!editable) return;
    const next = rememberTableView(document, viewId);
    if (next === document) return;
    selectionSavingRef.current = true;
    try { await save(next); }
    finally { selectionSavingRef.current = false; }
  }, [activateView, document, editable, save, saving]);

  return { activeViewId, activeView: document ? resolveTableView(document, activeViewId ?? initialViewId) : undefined, activateView, selectView };
}
