/**
 * Draw-to-shape: recognise a pen stroke as a clean board shape (Excalidraw's
 * draw-to-shape / Shift+X).
 *
 * A closed stroke whose points hug a rectangle, ellipse or diamond outline
 * converts into that box shape; a near-straight open stroke becomes a line.
 * Every candidate is scored by the mean distance of the stroke points from
 * its ideal outline (normalised by the bounding-box size), and the best score
 * wins when it lands under the acceptance threshold — a hand-drawn circle
 * scores ~0 against the ellipse but ~0.05 against the rectangle, so argmin
 * separates the three box kinds without per-kind tuning.
 */

import type { BoardShape } from './model';

/** A stroke whose bounding box is smaller than this stays ink (taps, ticks). */
const MIN_SHAPE_DIAGONAL = 24;
/** Mean outline error (fraction of the box size) a candidate must beat. */
const ACCEPT_ERROR = 0.12;
/** Open strokes closer than this to their ideal line become lines. */
const MAX_LINE_DEVIATION = 0.08;
/** Closure gap: Excalidraw's isPathALoop heuristic (start/end within 10% of
 *  the drawn perimeter counts as a loop). */
const CLOSURE_FRACTION = 0.1;

export interface ClosedShapeHit {
  kind: 'rect' | 'ellipse' | 'diamond';
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LineHit {
  kind: 'line';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export type StrokeShapeHit = ClosedShapeHit | LineHit;

export interface StrokeShapeOptions {
  id: string;
  /** Outline colour (the pen colour the stroke was drawn with). */
  color: string;
  strokeWidth: number;
  z: number;
  fill?: string;
  fillStyle?: 'hachure' | 'solid' | 'cross-hatch';
  roughness?: number;
  edges?: 'sharp' | 'round';
}

/** Recognise a completed pen stroke as a clean shape, or null to keep ink. */
export function recognizeStrokeShape(points: readonly (readonly number[])[]): StrokeShapeHit | null {
  if (points.length < 3) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const w = maxX - minX;
  const h = maxY - minY;
  if (Math.hypot(w, h) < MIN_SHAPE_DIAGONAL) return null;

  if (isClosedLoop(points)) {
    const scale = Math.max(w, h, 1);
    // Structural guards, not just error scores: a triangle hugging its bbox
    // scores low against both the rectangle and the inscribed ellipse, but a
    // rectangle's stroke visits all four bbox corners and an ellipse's never
    // does — so each candidate only exists when its outline geometry holds.
    const candidates: [number, ClosedShapeHit['kind']][] = [];
    if (coversBboxCorners(points, minX, minY, maxX, maxY)) {
      candidates.push([meanRectError(points, minX, minY, maxX, maxY) / scale, 'rect']);
    }
    if (cornersClearOfPoints(points, minX, minY, maxX, maxY)) {
      candidates.push([meanEllipseError(points, minX, minY, maxX, maxY) / scale, 'ellipse']);
    }
    candidates.push([meanDiamondError(points, minX, minY, maxX, maxY) / scale, 'diamond']);
    const [best, bestKind] = candidates.reduce((a, b) => (b[0] < a[0] ? b : a));
    if (best >= ACCEPT_ERROR) return null;
    return { kind: bestKind, x: minX, y: minY, w, h };
  }

  // Open stroke: near-straight paths become lines. Length is re-checked
  // because the diagonal guard above admits short fat strokes.
  const [x1, y1] = points[0];
  const [x2, y2] = points[points.length - 1];
  const length = Math.hypot(x2 - x1, y2 - y1);
  if (length < MIN_SHAPE_DIAGONAL) return null;
  let maxDeviation = 0;
  for (let index = 1; index < points.length - 1; index += 1) {
    maxDeviation = Math.max(maxDeviation, distanceToSegment(points[index][0], points[index][1], x1, y1, x2, y2));
  }
  if (maxDeviation > length * MAX_LINE_DEVIATION) return null;
  return { kind: 'line', x1, y1, x2, y2 };
}

/** Turn a recognition hit into a board shape carrying the stroke's style. */
export function shapeFromStrokeHit(hit: StrokeShapeHit, options: StrokeShapeOptions): BoardShape {
  const common = {
    id: options.id,
    stroke: options.color,
    strokeWidth: Math.max(1, options.strokeWidth),
    z: options.z,
  };
  const paint = {
    ...(options.fill ? { fill: options.fill } : {}),
    ...(options.fillStyle ? { fillStyle: options.fillStyle } : {}),
    ...(options.roughness !== undefined && options.roughness !== 1 ? { roughness: options.roughness } : {}),
  };
  if (hit.kind === 'line') {
    return {
      ...common,
      ...paint,
      shape: 'line',
      x: hit.x1,
      y: hit.y1,
      x2: hit.x2,
      y2: hit.y2,
      w: Math.abs(hit.x2 - hit.x1),
      h: Math.abs(hit.y2 - hit.y1),
    };
  }
  return {
    ...common,
    ...paint,
    ...(hit.kind === 'rect' && options.edges ? { edges: options.edges } : {}),
    shape: hit.kind,
    x: hit.x,
    y: hit.y,
    w: hit.w,
    h: hit.h,
  };
}

/** True when the stroke's start and end nearly meet (drawn perimeter / 10). */
function isClosedLoop(points: readonly (readonly number[])[]): boolean {
  let perimeter = 0;
  for (let index = 1; index < points.length; index += 1) {
    perimeter += Math.hypot(points[index][0] - points[index - 1][0], points[index][1] - points[index - 1][1]);
  }
  const gap = Math.hypot(points[0][0] - points[points.length - 1][0], points[0][1] - points[points.length - 1][1]);
  return perimeter > 0 && gap * (1 / CLOSURE_FRACTION) <= perimeter;
}

/** Corner reach: a hand-drawn rectangle rounds its corners by a fraction of
 *  the short side, so a point within this radius counts as visiting it. */
const CORNER_REACH = 0.2;

/** Corner clearance for the ellipse candidate: a true ellipse's outline keeps
 *  this much distance from the bbox corners (an inscribed ellipse's closest
 *  approach is (√2−1)/2 ≈ 0.207 of the short side). */
const CORNER_CLEARANCE = 0.15;

/** True when every bounding-box corner has a stroke point nearby — the
 *  signature of a rectangle (triangles always leave one corner empty). */
function coversBboxCorners(points: readonly (readonly number[])[], minX: number, minY: number, maxX: number, maxY: number): boolean {
  const reach = Math.max(4, CORNER_REACH * Math.min(maxX - minX, maxY - minY));
  for (const [cx, cy] of [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]]) {
    let visited = false;
    for (const [x, y] of points) {
      if (Math.hypot(x - cx, y - cy) <= reach) { visited = true; break; }
    }
    if (!visited) return false;
  }
  return true;
}

/** True when no stroke point crowds the bbox corners (ellipses stay clear). */
function cornersClearOfPoints(points: readonly (readonly number[])[], minX: number, minY: number, maxX: number, maxY: number): boolean {
  const clearance = Math.max(4, CORNER_CLEARANCE * Math.min(maxX - minX, maxY - minY));
  for (const [cx, cy] of [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]]) {
    for (const [x, y] of points) {
      if (Math.hypot(x - cx, y - cy) <= clearance) return false;
    }
  }
  return true;
}

/** Mean distance from the bounding-box edges (the ideal rectangle outline). */
function meanRectError(points: readonly (readonly number[])[], minX: number, minY: number, maxX: number, maxY: number): number {
  let sum = 0;
  for (const [x, y] of points) {
    sum += Math.min(x - minX, maxX - x, y - minY, maxY - y);
  }
  return sum / points.length;
}

/** Mean distance from the inscribed ellipse outline via the normalised radius. */
function meanEllipseError(points: readonly (readonly number[])[], minX: number, minY: number, maxX: number, maxY: number): number {
  const a = Math.max((maxX - minX) / 2, 1);
  const b = Math.max((maxY - minY) / 2, 1);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  let sum = 0;
  for (const [x, y] of points) {
    const radius = Math.sqrt(((x - cx) / a) ** 2 + ((y - cy) / b) ** 2);
    sum += Math.abs(radius - 1) * Math.min(a, b);
  }
  return sum / points.length;
}

/** Mean distance from the |dx|/a + |dy|/b = 1 diamond outline, scaled by the
 *  implicit function's gradient magnitude (exact off the corner diagonals). */
function meanDiamondError(points: readonly (readonly number[])[], minX: number, minY: number, maxX: number, maxY: number): number {
  const a = Math.max((maxX - minX) / 2, 1);
  const b = Math.max((maxY - minY) / 2, 1);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const gradient = Math.hypot(1 / a, 1 / b);
  let sum = 0;
  for (const [x, y] of points) {
    const implicit = Math.abs(x - cx) / a + Math.abs(y - cy) / b;
    sum += Math.abs(implicit - 1) / gradient;
  }
  return sum / points.length;
}

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
