/**
 * Lasso selection geometry — pure flow-space math, no React or model imports,
 * so the pointer handlers stay thin and the polygon rules stay unit-tested.
 *
 * Selection semantics: an element is selected only when it lies **fully
 * inside** the lasso region. The lasso path is an open polyline treated as
 * implicitly closed back to its first point.
 */

export type LassoPolygon = readonly (readonly number[])[];

/** Even-odd ray casting. Fewer than 3 points is not a region. */
export function pointInPolygon(x: number, y: number, polygon: LassoPolygon): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const crosses = yi > y !== yj > y;
    if (crosses && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Whether the box lies fully inside the lasso region. Probes the four
 *  corners plus the four edge midpoints (corners alone miss boxes that leak
 *  through a concave notch between them), each nudged a hair toward the
 *  center so a rope traced exactly along a card's bounds still counts as
 *  containment (ray casting is strict on the boundary). */
export function polygonContainsBox(
  polygon: LassoPolygon,
  x: number, y: number, w: number, h: number,
): boolean {
  if (polygon.length < 3 || w <= 0 || h <= 0) return false;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const probe = (px: number, py: number): boolean =>
    pointInPolygon(px + (cx - px) * CORNER_INSET, py + (cy - py) * CORNER_INSET, polygon);
  return probe(x, y) && probe(x + w, y) && probe(x + w, y + h) && probe(x, y + h)
    && probe(cx, y) && probe(x + w, cy) && probe(cx, y + h) && probe(x, cy);
}

/** Relative inward nudge for probes (fraction of the half-extent). */
const CORNER_INSET = 1e-6;
