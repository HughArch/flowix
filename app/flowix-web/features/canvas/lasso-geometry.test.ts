import { describe, expect, it } from 'vitest';
import { pointInPolygon, polygonContainsBox } from './lasso-geometry';

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
