/**
 * Bucket fill: click-to-paint for the board's box elements (Excalidraw-style
 * quick fill, applied as an overlay).
 *
 * The applied colour layers on top of what the element already carries:
 * blending the existing paint with the bucket colour at 50% instead of
 * replacing it, so repeated fills deepen and mixed fills tint. An element
 * with no fill takes the colour as-is; the transparent swatch clears.
 *
 * Targets are the closed box kinds — rect/ellipse/diamond shapes, frames,
 * and sticky notes — hit-tested topmost-first by stacking order.
 */

import type { BoardCard, BoardFrame, BoardShape } from './model';

export type BucketTarget =
  | { kind: 'shape'; id: string }
  | { kind: 'frame'; id: string }
  | { kind: 'sticky'; id: string };

export const BUCKET_BLEND_WEIGHT = 0.5;

/** Parse `#rgb` / `#rrggbb` into channels; null for anything else. */
export function parseHexColor(color: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return null;
  const hex = match[1];
  const expanded = hex.length === 3 ? hex.split('').map((ch) => ch + ch).join('') : hex;
  return [
    parseInt(expanded.slice(0, 2), 16),
    parseInt(expanded.slice(2, 4), 16),
    parseInt(expanded.slice(4, 6), 16),
  ];
}

function toHex([r, g, b]: [number, number, number]): string {
  const channel = (value: number) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/**
 * Overlay `paint` on `base`. A base without paint (transparent/empty) takes
 * the paint as-is; two paints mix in RGB space at `weight` toward the paint,
 * so layering the same colour deepens it toward that colour.
 */
export function blendHexColor(base: string | null | undefined, paint: string, weight = BUCKET_BLEND_WEIGHT): string {
  const overlay = parseHexColor(paint);
  if (!overlay) return paint;
  const under = base && base !== 'transparent' ? parseHexColor(base) : null;
  if (!under) return toHex(overlay);
  return toHex([
    under[0] * (1 - weight) + overlay[0] * weight,
    under[1] * (1 - weight) + overlay[1] * weight,
    under[2] * (1 - weight) + overlay[2] * weight,
  ]);
}

/** Box containment for the fillable shape kinds (rect/ellipse/diamond). */
function pointInShape(shape: BoardShape, x: number, y: number): boolean {
  if (shape.shape === 'ellipse') {
    const a = Math.max(shape.w / 2, 1);
    const b = Math.max(shape.h / 2, 1);
    const dx = x - (shape.x + shape.w / 2);
    const dy = y - (shape.y + shape.h / 2);
    return (dx * dx) / (a * a) + (dy * dy) / (b * b) <= 1;
  }
  if (shape.shape === 'diamond') {
    const a = Math.max(shape.w / 2, 1);
    const b = Math.max(shape.h / 2, 1);
    const dx = Math.abs(x - (shape.x + shape.w / 2));
    const dy = Math.abs(y - (shape.y + shape.h / 2));
    return dx / a + dy / b <= 1;
  }
  return x >= shape.x && x <= shape.x + shape.w && y >= shape.y && y <= shape.y + shape.h;
}

/**
 * The box element under a flow-space point, topmost-first. Cards (z 10)
 * sit above shapes (z 5), frames (z 0) are backdrops under everything;
 * equal z falls back to array order (later entries render on top). Ink,
 * connectors and standalone labels are not fillable and never block a hit.
 */
export function bucketTargetAt(
  shapes: readonly BoardShape[],
  cards: readonly BoardCard[],
  frames: readonly BoardFrame[],
  x: number,
  y: number,
): BucketTarget | null {
  const candidates: { target: BucketTarget; z: number; order: number }[] = [];
  shapes.forEach((shape, order) => {
    if (shape.shape !== 'rect' && shape.shape !== 'ellipse' && shape.shape !== 'diamond') return;
    if (!pointInShape(shape, x, y)) return;
    candidates.push({ target: { kind: 'shape', id: shape.id }, z: shape.z ?? 5, order });
  });
  cards.forEach((card, order) => {
    if (card.kind !== 'text') return;
    if (x < card.x || x > card.x + card.w || y < card.y || y > card.y + card.h) return;
    candidates.push({ target: { kind: 'sticky', id: card.id }, z: card.z ?? 10, order });
  });
  frames.forEach((frame, order) => {
    if (x < frame.x || x > frame.x + frame.w || y < frame.y || y > frame.y + frame.h) return;
    candidates.push({ target: { kind: 'frame', id: frame.id }, z: 0, order });
  });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.z - b.z || a.order - b.order);
  return candidates[candidates.length - 1].target;
}
