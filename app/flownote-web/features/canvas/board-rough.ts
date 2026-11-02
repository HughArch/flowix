/**
 * Hand-drawn shape outlines via roughjs (the renderer Excalidraw uses).
 *
 * Paths are generated per shape and cached by a signature that includes the
 * rough seed, so a shape keeps the same wobble across renders and views while
 * the geometry stays a plain rect/ellipse/diamond in the document.
 */

import rough from 'roughjs/bin/rough';
import type { BoardShape } from './model';

export interface RoughPath {
  d: string;
  stroke: string;
  strokeWidth: number;
  fill?: string;
  /** Dash pattern from roughjs, rendered via stroke-dasharray. */
  strokeDash?: string;
  /** 0..1 alpha for the fill paint of this path. */
  fillAlpha?: number;
}

const generator = rough.generator();

/** Stable pseudo-random seed per shape so the sketch does not jitter on re-render. */
function seedFor(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) % 2_147_483_647;
  }
  return hash || 1;
}

function dashFor(shape: BoardShape): number[] | undefined {
  if (shape.strokeStyle === 'dashed') return [8, 6];
  if (shape.strokeStyle === 'dotted') return [1.5, 5];
  return undefined;
}

export interface RoughOptions {
  /** Preview renders omit the fill and use a lighter roughness. */
  preview?: boolean;
}

export function roughPathsFor(shape: BoardShape, options: RoughOptions = {}): RoughPath[] {
  const stroke = shape.stroke ?? '#64748b';
  const fill = options.preview ? undefined : shape.fill && shape.fill !== 'transparent' ? shape.fill : undefined;
  const strokeWidth = shape.strokeWidth ?? 2;
  const base = {
    stroke,
    strokeWidth,
    roughness: options.preview ? 1.2 : shape.roughness ?? 1,
    bowing: 1,
    seed: seedFor(shape.id),
    ...(fill ? { fill, fillStyle: shape.fillStyle ?? 'solid' as const, fillWeight: 1 } : {}),
    ...(dashFor(shape) ? { strokeLineDash: dashFor(shape) } : {}),
  };
  const width = Math.max(2, shape.w);
  const height = Math.max(2, shape.h);
  const drawable = shape.shape === 'ellipse'
    ? generator.ellipse(shape.x + width / 2, shape.y + height / 2, width, height, base)
    : shape.shape === 'diamond'
      ? generator.polygon(
        [
          [shape.x + width / 2, shape.y],
          [shape.x + width, shape.y + height / 2],
          [shape.x + width / 2, shape.y + height],
          [shape.x, shape.y + height / 2],
        ],
        base,
      )
      : generator.path(roundedRectPath(shape.x, shape.y, width, height, shape.edges === 'round' ? Math.min(24, Math.min(width, height) / 4) : 0), base);

  // toPaths() drops strokeLineDash — it only survives on drawable.options and
  // roughjs's own SVG renderer reads it from there. Carry it onto the stroke
  // paths ourselves.
  const dash = (drawable.options as { strokeLineDash?: number[] }).strokeLineDash;
  return generator.toPaths(drawable).map((path) => ({
    d: path.d,
    stroke: path.stroke ?? stroke,
    strokeWidth: path.strokeWidth ?? strokeWidth,
    ...(path.fill && path.fill !== 'none' ? { fill: path.fill } : {}),
    ...(dash && path.stroke !== 'none' ? { strokeDash: dash.join(' ') } : {}),
  }));
}

/** Rounded-corner rectangle path; radius 0 degenerates to sharp corners. */
function roundedRectPath(x: number, y: number, w: number, h: number, radius: number): string {
  if (radius <= 0) return `M${x},${y} h${w} v${h} h${-w} Z`;
  return [
    `M${x + radius},${y}`,
    `h${w - radius * 2}`,
    `a${radius},${radius} 0 0 1 ${radius},${radius}`,
    `v${h - radius * 2}`,
    `a${radius},${radius} 0 0 1 ${-radius},${radius}`,
    `h${-(w - radius * 2)}`,
    `a${radius},${radius} 0 0 1 ${-radius},${-radius}`,
    `v${-(h - radius * 2)}`,
    `a${radius},${radius} 0 0 1 ${radius},${-radius}`,
    'Z',
  ].join(' ');
}

/** Rough line for arrows, so connectors match the sketch style. */
export function roughLineSketch(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  shape: BoardShape,
  options: RoughOptions = {},
): { d: string; dash?: string } {
  const drawable = generator.line(x1, y1, x2, y2, {
    stroke: shape.stroke ?? '#64748b',
    strokeWidth: shape.strokeWidth ?? 2,
    roughness: options.preview ? 1.2 : shape.roughness ?? 1,
    bowing: 1,
    seed: seedFor(shape.id),
    ...(dashFor(shape) ? { strokeLineDash: dashFor(shape) } : {}),
  });
  const dash = (drawable.options as { strokeLineDash?: number[] }).strokeLineDash;
  return {
    d: generator.toPaths(drawable).map((path) => path.d).join(' '),
    ...(dash ? { dash: dash.join(' ') } : {}),
  };
}

/** Cache key: geometry + style; anything visual that changes the sketch. */
export function roughSignature(shape: BoardShape, preview = false): string {
  return [
    shape.id, shape.shape, shape.x, shape.y, shape.w, shape.h,
    shape.stroke, shape.fill, shape.fillStyle, shape.strokeWidth, shape.strokeStyle,
    shape.roughness, shape.edges, preview ? 'p' : '',
  ].join('|');
}

const cache = new Map<string, RoughPath[]>();

export function cachedRoughPaths(shape: BoardShape, preview = false): RoughPath[] {
  const key = roughSignature(shape, preview);
  const hit = cache.get(key);
  if (hit) return hit;
  const paths = roughPathsFor(shape, { preview });
  // Keep the cache bounded while a drag generates many preview geometries.
  if (cache.size > 400) cache.clear();
  cache.set(key, paths);
  return paths;
}
