export interface DragPoint {
  x: number;
  y: number;
}

export interface DragPayload<Item = unknown> {
  sessionId: string;
  sourceId: string;
  items: readonly Item[];
}

export type DropDecision =
  | { accepted: true }
  | { accepted: false; reason?: string };

export interface DropPreview<Item, Location> {
  payload: DragPayload<Item>;
  location: Location;
  decision: DropDecision;
  point: DragPoint;
}

export interface DropTarget<Item, Location> {
  /** Must be unique while this target is registered. */
  id: string;
  /** Higher priority wins when targets overlap. A rejected target still blocks lower-priority targets. */
  priority?: number;
  hitTest: (point: DragPoint) => Location | null;
  locationKey: (location: Location) => string;
  evaluate: (payload: DragPayload<Item>, location: Location) => DropDecision;
  onPreview: (preview: DropPreview<Item, Location> | null) => void;
  onDrop: (payload: DragPayload<Item>, location: Location) => void | Promise<void>;
  onReject?: (payload: DragPayload<Item>, location: Location, reason?: string) => void;
  onError: (error: unknown) => void;
}

interface ActiveDropTarget {
  id: string;
  key: string;
  preview: DropPreview<unknown, unknown>;
  target: DropTarget<unknown, unknown>;
}

interface ActiveDrag {
  payload: DragPayload<unknown>;
  point: DragPoint;
  target: ActiveDropTarget | null;
  onCancel?: () => void;
  releaseTextSelection: () => void;
}

const targets = new Map<string, DropTarget<unknown, unknown>>();
let activeDrag: ActiveDrag | null = null;
let registrationOrder = 0;
const targetOrder = new Map<string, number>();
const DRAG_SELECTION_CLASS = 'flowix-drag-drop-active';
let textSelectionSuppressionCount = 0;

export function suppressTextSelectionForDrag(): () => void {
  if (textSelectionSuppressionCount++ === 0 && typeof document !== 'undefined') {
    document.documentElement.classList.add(DRAG_SELECTION_CLASS);
    window.getSelection()?.removeAllRanges();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    textSelectionSuppressionCount = Math.max(0, textSelectionSuppressionCount - 1);
    if (textSelectionSuppressionCount === 0 && typeof document !== 'undefined') {
      document.documentElement.classList.remove(DRAG_SELECTION_CLASS);
    }
  };
}

function findTarget(point: DragPoint, payload: DragPayload<unknown>): ActiveDropTarget | null {
  const ordered = [...targets.values()].sort((left, right) => {
    const priorityDifference = (right.priority ?? 0) - (left.priority ?? 0);
    return priorityDifference || (targetOrder.get(right.id) ?? 0) - (targetOrder.get(left.id) ?? 0);
  });
  for (const target of ordered) {
    const location = target.hitTest(point);
    if (location === null) continue;
    return {
      id: target.id,
      key: target.locationKey(location),
      target,
      preview: {
        payload,
        location,
        decision: target.evaluate(payload, location),
        point,
      },
    };
  }
  return null;
}

function clearTargetPreview(target: ActiveDropTarget | null): void {
  target?.target.onPreview(null);
}

function updateTarget(drag: ActiveDrag): void {
  const next = findTarget(drag.point, drag.payload);
  const current = drag.target;
  if (current && next && current.id === next.id && current.key === next.key
    && current.preview.decision.accepted === next.preview.decision.accepted
    && (current.preview.decision.accepted || current.preview.decision.reason === next.preview.decision.reason)) {
    return;
  }
  if (!current || !next || current.id !== next.id || current.key !== next.key) clearTargetPreview(current);
  drag.target = next;
  next?.target.onPreview(next.preview);
}

function clearActiveDrag(): ActiveDrag | null {
  const previous = activeDrag;
  activeDrag = null;
  previous?.releaseTextSelection();
  clearTargetPreview(previous?.target ?? null);
  return previous;
}

function cancelOnEscape(event: KeyboardEvent): void {
  if (event.key === 'Escape') cancelDragSession();
}

function cancelOnBlur(): void {
  cancelDragSession();
}

export function registerDropTarget<Item, Location>(target: DropTarget<Item, Location>): () => void {
  targets.set(target.id, target as unknown as DropTarget<unknown, unknown>);
  targetOrder.set(target.id, ++registrationOrder);
  if (activeDrag) updateTarget(activeDrag);
  return () => {
    if (targets.get(target.id) !== target) return;
    targets.delete(target.id);
    targetOrder.delete(target.id);
    if (activeDrag?.target?.id === target.id) {
      clearTargetPreview(activeDrag.target);
      activeDrag.target = null;
      updateTarget(activeDrag);
    }
  };
}

export function beginDragSession(
  payload: DragPayload<unknown>,
  point: DragPoint,
  onCancel?: () => void,
): void {
  cancelDragSession();
  activeDrag = { payload, point, target: null, onCancel, releaseTextSelection: suppressTextSelectionForDrag() };
  window.addEventListener('keydown', cancelOnEscape);
  window.addEventListener('blur', cancelOnBlur);
  updateTarget(activeDrag);
}

export function moveDragSession(sessionId: string, point: DragPoint): void {
  if (!activeDrag || activeDrag.payload.sessionId !== sessionId) return;
  activeDrag.point = point;
  updateTarget(activeDrag);
}

export function endDragSession(sessionId: string, point: DragPoint): boolean {
  if (!activeDrag || activeDrag.payload.sessionId !== sessionId) return false;
  activeDrag.point = point;
  updateTarget(activeDrag);
  const completed = clearActiveDrag();
  window.removeEventListener('keydown', cancelOnEscape);
  window.removeEventListener('blur', cancelOnBlur);
  const target = completed?.target;
  if (!target) return false;
  if (!target.preview.decision.accepted) {
    target.target.onReject?.(target.preview.payload, target.preview.location, target.preview.decision.reason);
    return true;
  }
  void Promise.resolve()
    .then(() => target.target.onDrop(target.preview.payload, target.preview.location))
    .catch((error) => target.target.onError(error));
  return true;
}

export function cancelDragSession(sessionId?: string): void {
  if (!activeDrag || (sessionId !== undefined && activeDrag.payload.sessionId !== sessionId)) return;
  const cancelled = clearActiveDrag();
  window.removeEventListener('keydown', cancelOnEscape);
  window.removeEventListener('blur', cancelOnBlur);
  cancelled?.onCancel?.();
}
