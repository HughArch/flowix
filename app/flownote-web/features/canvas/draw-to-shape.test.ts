import { describe, expect, it } from 'vitest';
import { recognizeStrokeShape, shapeFromStrokeHit } from './draw-to-shape';

/** Deterministic PRNG so jittered fixtures never flake. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Interpolate the polyline to ~2px spacing and add deterministic wobble. */
function handDrawn(points: readonly (readonly number[])[], jitter = 1.5, seed = 7): number[][] {
  const random = mulberry32(seed);
  const result: number[][] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const [ax, ay] = points[index];
    const [bx, by] = points[index + 1];
    const steps = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / 2));
    for (let step = 0; step < steps; step += 1) {
      const t = step / steps;
      result.push([ax + (bx - ax) * t + (random() - 0.5) * jitter * 2, ay + (by - ay) * t + (random() - 0.5) * jitter * 2]);
    }
  }
  const [lx, ly] = points[points.length - 1];
  result.push([lx + (random() - 0.5) * jitter * 2, ly + (random() - 0.5) * jitter * 2]);
  return result;
}

/** Perimeter of a box, walked clockwise back to the start point. */
function rectStroke(x: number, y: number, w: number, h: number, seed = 7): number[][] {
  return handDrawn([[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]], 1.5, seed);
}

/** Samples around an inscribed ellipse, closed back to the first sample. */
function ellipseStroke(cx: number, cy: number, a: number, b: number, seed = 11): number[][] {
  const samples: number[][] = [];
  for (let index = 0; index < 72; index += 1) {
    const angle = (index / 72) * Math.PI * 2;
    samples.push([cx + a * Math.cos(angle), cy + b * Math.sin(angle)]);
  }
  samples.push(samples[0]);
  return handDrawn(samples, 1.5, seed);
}

/** Four corners of a diamond with subdivided edges, closed. */
function diamondStroke(cx: number, cy: number, a: number, b: number, seed = 13): number[][] {
  return handDrawn([
    [cx, cy - b], [cx + a, cy], [cx, cy + b], [cx - a, cy], [cx, cy - b],
  ], 1.5, seed);
}

/** Rectangle rotated by `deg` around its centre, closed. */
function tiltedRectStroke(cx: number, cy: number, w: number, h: number, deg: number, seed = 17): number[][] {
  const rad = (deg * Math.PI) / 180;
  const ring = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2], [-w / 2, -h / 2]];
  return handDrawn(ring.map(([x, y]) => [
    cx + x * Math.cos(rad) - y * Math.sin(rad),
    cy + x * Math.sin(rad) + y * Math.cos(rad),
  ]), 1.5, seed);
}

describe('recognizeStrokeShape', () => {
  it('converts hand-drawn rectangles, ellipses, and diamonds', () => {
    const rect = recognizeStrokeShape(rectStroke(40, 20, 200, 140));
    expect(rect?.kind).toBe('rect');
    if (rect?.kind === 'rect') {
      // Jitter moves the bounding box by a couple of pixels at most.
      expect(Math.abs(rect.x - 40)).toBeLessThanOrEqual(3);
      expect(Math.abs(rect.w - 200)).toBeLessThanOrEqual(4);
    }
    expect(recognizeStrokeShape(ellipseStroke(140, 90, 100, 70))?.kind).toBe('ellipse');
    expect(recognizeStrokeShape(diamondStroke(140, 90, 100, 70))?.kind).toBe('diamond');
  });

  it('converts a tilted rectangle regardless of drawing angle', () => {
    expect(recognizeStrokeShape(tiltedRectStroke(150, 120, 220, 140, 15))?.kind).toBe('rect');
    expect(recognizeStrokeShape(tiltedRectStroke(150, 120, 220, 140, 30))?.kind).toBe('rect');
    // A 45°-tilted square IS a diamond geometrically.
    expect(recognizeStrokeShape(tiltedRectStroke(150, 150, 200, 200, 45))?.kind).toBe('diamond');
  });

  it('keeps a sloppy rectangle sloppy-free: each kind scores its own outline best', () => {
    // A circle inscribed in a square bbox must read ellipse, not rect.
    const circle = ellipseStroke(100, 100, 100, 100);
    expect(recognizeStrokeShape(circle)?.kind).toBe('ellipse');
    // A square must read rect, not ellipse (corners are far off the ellipse).
    expect(recognizeStrokeShape(rectStroke(0, 0, 200, 200))?.kind).toBe('rect');
  });

  it('converts a near-straight open stroke into a line', () => {
    const hit = recognizeStrokeShape(handDrawn([[10, 10], [210, 110]], 1, 3));
    expect(hit?.kind).toBe('line');
    if (hit?.kind === 'line') {
      // Jitter lands the endpoints within a couple of pixels.
      expect(Math.abs(hit.x1 - 10)).toBeLessThanOrEqual(2);
      expect(Math.abs(hit.y2 - 110)).toBeLessThanOrEqual(2);
    }
  });

  it('keeps squiggles, triangles, open loops, taps, and tiny marks as ink', () => {
    // Open sine-wave squiggle.
    const squiggle: number[][] = [];
    for (let index = 0; index <= 60; index += 1) squiggle.push([index * 4, 50 + Math.sin(index / 3) * 30]);
    expect(recognizeStrokeShape(squiggle)).toBeNull();
    // Triangle: fits no box kind under the threshold.
    expect(recognizeStrokeShape(handDrawn([[100, 0], [200, 173], [0, 173], [100, 0]], 1.5, 5))).toBeNull();
    // Open "C": the gap exceeds the closure fraction, and it is not straight.
    expect(recognizeStrokeShape(handDrawn([[150, 20], [50, 20], [50, 180], [150, 180]], 1.5, 9))).toBeNull();
    // Tap (duplicated point) and a tiny mark.
    expect(recognizeStrokeShape([[10, 10]])).toBeNull();
    expect(recognizeStrokeShape([[10, 10], [10.1, 10.1], [10.2, 10.2]])).toBeNull();
    // Closed loop smaller than the minimum size stays ink.
    expect(recognizeStrokeShape(rectStroke(0, 0, 10, 8))).toBeNull();
  });
});

describe('shapeFromStrokeHit', () => {
  it('builds a box shape carrying the stroke style', () => {
    const shape = shapeFromStrokeHit(
      { kind: 'rect', x: 10, y: 20, w: 200, h: 140 },
      { id: 's_test', color: '#1971c2', strokeWidth: 5, z: 7, fill: '#d0ebff', fillStyle: 'hachure', roughness: 2, edges: 'round' },
    );
    expect(shape).toMatchObject({
      id: 's_test', shape: 'rect', x: 10, y: 20, w: 200, h: 140,
      stroke: '#1971c2', strokeWidth: 5, z: 7, fill: '#d0ebff', fillStyle: 'hachure', roughness: 2, edges: 'round',
    });
  });

  it('builds a two-point line shape with endpoint geometry', () => {
    const shape = shapeFromStrokeHit(
      { kind: 'line', x1: 5, y1: 6, x2: 205, y2: 6 },
      { id: 's_line', color: '#1e1e1e', strokeWidth: 2, z: 3 },
    );
    expect(shape).toMatchObject({
      shape: 'line', x: 5, y: 6, x2: 205, y2: 6, w: 200, h: 0,
      stroke: '#1e1e1e', strokeWidth: 2, z: 3,
    });
    // Lines carry no fill; edges only apply to rectangles.
    expect('fill' in shape).toBe(false);
    expect('edges' in shape).toBe(false);
  });
});
