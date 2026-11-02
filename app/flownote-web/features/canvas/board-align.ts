/**
 * Align & distribute math for board shapes.
 *
 * Pure functions that mutate the given shapes in place (they are the same
 * objects the document holds), so the caller only needs to persist afterwards.
 */

import type { BoardShape } from './model';

export type BoardAlignMode = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';

/** Align shapes inside their common bounding box; no-op under 2 shapes. */
export function alignShapes(shapes: BoardShape[], mode: BoardAlignMode): void {
  if (shapes.length < 2) return;
  const minX = Math.min(...shapes.map((shape) => shape.x));
  const maxX = Math.max(...shapes.map((shape) => shape.x + shape.w));
  const minY = Math.min(...shapes.map((shape) => shape.y));
  const maxY = Math.max(...shapes.map((shape) => shape.y + shape.h));
  for (const shape of shapes) {
    if (mode === 'left') shape.x = minX;
    if (mode === 'hcenter') shape.x = minX + (maxX - minX - shape.w) / 2;
    if (mode === 'right') shape.x = maxX - shape.w;
    if (mode === 'top') shape.y = minY;
    if (mode === 'vcenter') shape.y = minY + (maxY - minY - shape.h) / 2;
    if (mode === 'bottom') shape.y = maxY - shape.h;
  }
}

/** Even spacing between the outermost shapes on one axis; needs 3+ shapes. */
export function distributeShapes(shapes: BoardShape[], axis: 'h' | 'v'): void {
  if (shapes.length < 3) return;
  const posKey = axis === 'h' ? 'x' as const : 'y' as const;
  const sizeKey = axis === 'h' ? 'w' as const : 'h' as const;
  const ordered = [...shapes].sort((a, b) => a[posKey] - b[posKey]);
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const span = (last[posKey] + last[sizeKey]) - first[posKey];
  const totalSize = ordered.reduce((sum, shape) => sum + shape[sizeKey], 0);
  const gap = (span - totalSize) / (ordered.length - 1);
  let cursor = first[posKey];
  for (const shape of ordered) {
    shape[posKey] = cursor;
    cursor += shape[sizeKey] + gap;
  }
}
