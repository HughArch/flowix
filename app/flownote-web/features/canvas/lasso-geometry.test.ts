import { describe, expect, it } from 'vitest';
import { pointInPolygon, polygonContainsBox, polygonContainsElement } from './lasso-geometry';

/** Unit square lasso: (0,0) → (10,0) → (10,10) → (0,10). */
const SQUARE = [[0, 0], [10, 0], [10, 10], [0, 10]] as const;
/** Concave "U" opening upwards: a point in the notch must read outside. */
const U_SHAPE = [[0, 10], [0, 0], [10, 0], [10, 10], [7, 10], [7, 4], [3, 4], [3, 10]] as const;

describe('pointInPolygon', () => {
  it('classifies points inside, outside, and in concave notches', () => {
    expect(pointInPolygon(5, 5, SQUARE)).toBe(true);
    expect(pointInPolygon(15, 5, SQUARE)).toBe(false);
    expect(pointInPolygon(-1, -1, SQUARE)).toBe(false);
    // The notch of the U (above y=4, between x=3 and x=7) is outside.
    expect(pointInPolygon(5, 8, U_SHAPE)).toBe(false);
    expect(pointInPolygon(1, 8, U_SHAPE)).toBe(true);
    expect(pointInPolygon(5, 2, U_SHAPE)).toBe(true);
  });

  it('is not a region below three points', () => {
    expect(pointInPolygon(0, 0, [])).toBe(false);
    expect(pointInPolygon(0, 0, [[0, 0], [10, 10]])).toBe(false);
  });
});

describe('polygonContainsBox', () => {
  it('accepts boxes fully inside the lasso', () => {
    expect(polygonContainsBox(SQUARE, 3, 3, 2, 2)).toBe(true);
    expect(polygonContainsBox(SQUARE, 0, 0, 10, 10)).toBe(true);
  });

  it('rejects boxes that merely touch or cross the rope', () => {
    // Only part of the box is inside: not selected.
    expect(polygonContainsBox(SQUARE, 9, 4, 8, 3)).toBe(false);
    expect(polygonContainsBox(SQUARE, -1, 4, 8, 3)).toBe(false);
    // A triangle region overlapping part of the box: not selected.
    const triangle = [[0, 0], [20, 0], [0, 20]] as const;
    expect(polygonContainsBox(triangle, 5, 5, 30, 30)).toBe(false);
    // Entirely outside.
    expect(polygonContainsBox(SQUARE, 11, 4, 8, 3)).toBe(false);
  });

  it('respects concave regions', () => {
    // A box straddling the U's notch has corners in the void: outside.
    expect(polygonContainsBox(U_SHAPE, 2, 6, 6, 3)).toBe(false);
    // A box tucked into one leg of the U is fully inside.
    expect(polygonContainsBox(U_SHAPE, 0.5, 6, 2, 3)).toBe(true);
  });

  it('rejects degenerate inputs', () => {
    expect(polygonContainsBox([], 0, 0, 10, 10)).toBe(false);
    expect(polygonContainsBox([[0, 0]], 0, 0, 10, 10)).toBe(false);
    expect(polygonContainsBox(SQUARE, 0, 0, 0, 10)).toBe(false);
  });
});

describe('polygonContainsElement', () => {
  /** 100x100 element: (1,1) → (101,101). */
  const ELEMENT = { x: 1, y: 1, w: 100, h: 100 };
  /** Rope 1px outside the element outline. */
  const HUGGING = [[0, 0], [102, 0], [102, 102], [0, 102]] as const;
  /** Rope tracing the inner edge, 3px inside the outline. */
  const INNER = [[4, 4], [98, 4], [98, 98], [4, 98]] as const;
  /** Rope slicing 9px deep — past the 6px tolerance shell. */
  const SLICING = [[10, 10], [92, 10], [92, 92], [10, 92]] as const;

  it('forgives a rope that hugs or slightly clips the element edge', () => {
    expect(polygonContainsElement(HUGGING, ELEMENT)).toBe(true);
    expect(polygonContainsElement(INNER, ELEMENT)).toBe(true);
    expect(polygonContainsElement(SLICING, ELEMENT)).toBe(false);
  });

  it('keeps strict containment for elements smaller than the shell', () => {
    // A 10x10 element inside the 10x10 square lasso cannot carry a 6px
    // shell; the rope must enclose the element box itself.
    expect(polygonContainsElement(SQUARE, { x: 0, y: 0, w: 10, h: 10 })).toBe(true);
    expect(polygonContainsElement(SQUARE, { x: 0, y: 0, w: 11, h: 10 })).toBe(false);
  });

  it('treats zero-extent strokes as contained when both endpoints are in', () => {
    // Horizontal line segment fully inside the square lasso.
    expect(polygonContainsElement(SQUARE, { x: 2, y: 5, w: 6, h: 0 })).toBe(true);
    // Segment crossing the rope boundary: the far endpoint is outside.
    expect(polygonContainsElement(SQUARE, { x: 2, y: 5, w: 12, h: 0 })).toBe(false);
  });
});
