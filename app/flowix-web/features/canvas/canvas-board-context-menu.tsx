'use client';

/**
 * Canvas board context menu — the right-click (and touch long-press) menu for
 * the card board.
 *
 * The board owns the hit-testing and gesture handling (flow pane context
 * events, long-press in its capture-phase pointer handlers); this component is
 * a thin imperative shell over the shared `ContextMenu`: the board calls
 * `open(request, items)` with the screen point and the item list it built for
 * the current selection state, and the menu renders at that point. One menu
 * instance per board serves all three modes (selection / board / edge) — the
 * mode only decides what the board puts into `items`.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  useContextMenuContext,
} from '@shared/ui/context-menu';

/** Where and why the menu should open; the board derives the entries. */
export type BoardContextMenuRequest =
  | { mode: 'selection'; screen: { x: number; y: number }; flowPoint: [number, number] }
  | { mode: 'board'; screen: { x: number; y: number }; flowPoint: [number, number] }
  | { mode: 'edge'; screen: { x: number; y: number } };

export type BoardContextMenuItem =
  | { kind: 'separator' }
  | {
      kind: 'item';
      id: string;
      label: string;
      /** Platform-formatted chord text (`formatChord` output), if any. */
      shortcut?: string;
      disabled?: boolean;
      onSelect: () => void;
    };

interface CapturedMenuApi {
  openAt: (x: number, y: number, trigger?: HTMLElement) => void;
  /** Zero-arg closer ('outside' reason: no focus restore to a trigger). */
  close: () => void;
}

/** Captures the provider's `openAt`/`close` so the imperative handle can open
 *  the menu from pointer handlers — right-click on the flow pane and touch
 *  long-press have no trigger element for the normal `ContextMenuTrigger` —
 *  and dismiss it when the board pans or zooms under the open menu. */
function MenuApiCapture({ apiRef }: { apiRef: React.RefObject<CapturedMenuApi | null> }) {
  const { openAt, close } = useContextMenuContext();
  useEffect(() => {
    apiRef.current = {
      openAt,
      close: () => close('outside'),
    };
  }, [apiRef, close, openAt]);
  return null;
}

export interface CanvasBoardContextMenuHandle {
  open: (request: BoardContextMenuRequest, items: BoardContextMenuItem[]) => void;
  close: () => void;
}

export const CanvasBoardContextMenu = forwardRef<CanvasBoardContextMenuHandle>(function CanvasBoardContextMenu(_props, ref) {
  const apiRef = useRef<CapturedMenuApi | null>(null);
  const [items, setItems] = useState<BoardContextMenuItem[]>([]);
  useImperativeHandle(ref, () => ({
    open: (request, nextItems) => {
      setItems(nextItems);
      apiRef.current?.openAt(request.screen.x, request.screen.y);
    },
    close: () => apiRef.current?.close(),
  }), []);
  return (
    <ContextMenu>
      <MenuApiCapture apiRef={apiRef} />
      <ContextMenuContent className="w-[220px]">
        {items.map((item, index) => (
          item.kind === 'separator'
            ? <ContextMenuSeparator key={`sep-${index}`} />
            : (
              <ContextMenuItem key={item.id} disabled={item.disabled} onSelect={item.onSelect}>
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.shortcut ? <ContextMenuShortcut>{item.shortcut}</ContextMenuShortcut> : null}
              </ContextMenuItem>
            )
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
});
