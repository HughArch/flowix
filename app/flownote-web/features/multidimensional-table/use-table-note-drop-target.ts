import { useEffect, useRef } from 'react';
import { isMarkdownNoteDragResource, type NotebookNoteDragResource } from '@features/memo/public/drag-resource-api';
import { registerDropTarget, type DropPreview } from '@shared/drag-drop/drag-drop-coordinator';
import type { TableNoteDropPreview, TableNoteDropRejection } from './table-note-drop';

export type TableNoteDropTargetRejection =
  | TableNoteDropRejection['reason']
  | 'unsupported-resource'
  | 'wrong-notebook'
  | 'read-only';

interface TableNoteDropTargetOptions<Location> {
  id: string;
  active: boolean;
  notebookId: string | null;
  canDrop: boolean;
  canHandleDrop: boolean;
  hitTest: (point: { x: number; y: number }) => Location | null;
  locationKey: (location: Location) => string;
  preview: (notes: NotebookNoteDragResource[], location: Location) => TableNoteDropPreview | TableNoteDropRejection;
  onPreview: (preview: TableNoteDropPreview | null) => void;
  onDrop: (notes: NotebookNoteDragResource[], location: Location) => void | Promise<void>;
  onReject: (reason: TableNoteDropTargetRejection) => void;
  onError: (error: unknown) => void;
}

/** Shares note eligibility, preview caching and target lifecycle across table and gallery drops. */
export function useTableNoteDropTarget<Location>(options: TableNoteDropTargetOptions<Location>): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const previewCacheRef = useRef<{
    sessionId: string;
    items: readonly unknown[];
    locationKey: string;
    planner: TableNoteDropTargetOptions<Location>['preview'];
    result: TableNoteDropPreview | TableNoteDropRejection;
  } | null>(null);

  useEffect(() => {
    if (!options.active) {
      optionsRef.current.onPreview(null);
      return;
    }
    const resolvePreview = (items: readonly unknown[], sessionId: string, location: Location) => {
      const current = optionsRef.current;
      const key = current.locationKey(location);
      const cached = previewCacheRef.current;
      if (cached && cached.sessionId === sessionId && cached.items === items
        && cached.locationKey === key && cached.planner === current.preview) return cached.result;
      const notes = items.filter(isMarkdownNoteDragResource);
      const result = current.preview(notes, location);
      previewCacheRef.current = { sessionId, items, locationKey: key, planner: current.preview, result };
      return result;
    };
    return registerDropTarget<unknown, Location>({
      id: options.id,
      priority: 100,
      hitTest: (point) => optionsRef.current.hitTest(point),
      locationKey: (location) => optionsRef.current.locationKey(location),
      evaluate: (payload, location) => {
        const current = optionsRef.current;
        const notes = payload.items.filter(isMarkdownNoteDragResource);
        if (!notes.length || notes.length !== payload.items.length) return { accepted: false, reason: 'unsupported-resource' };
        if (!current.notebookId || notes.some((note) => note.notebookId !== current.notebookId)) {
          return { accepted: false, reason: 'wrong-notebook' };
        }
        if (!current.canDrop) return { accepted: false, reason: 'read-only' };
        if (!current.canHandleDrop) return { accepted: false, reason: 'unavailable' };
        const plan = resolvePreview(payload.items, payload.sessionId, location);
        return 'reason' in plan ? { accepted: false, reason: plan.reason } : { accepted: true };
      },
      onPreview: (preview: DropPreview<unknown, Location> | null) => {
        if (!preview?.decision.accepted) {
          optionsRef.current.onPreview(null);
          return;
        }
        const next = resolvePreview(preview.payload.items, preview.payload.sessionId, preview.location);
        optionsRef.current.onPreview('reason' in next ? null : next);
      },
      onDrop: (payload, location) => optionsRef.current.onDrop(
        payload.items.filter(isMarkdownNoteDragResource), location,
      ),
      onReject: (_payload, _location, reason) => {
        optionsRef.current.onReject(isTableNoteDropTargetRejection(reason) ? reason : 'unavailable');
      },
      onError: (error) => optionsRef.current.onError(error),
    });
  }, [options.active, options.id]);
}

function isTableNoteDropTargetRejection(reason: string | undefined): reason is TableNoteDropTargetRejection {
  return reason === 'filtered' || reason === 'unavailable' || reason === 'unsupported-resource'
    || reason === 'wrong-notebook' || reason === 'read-only';
}
