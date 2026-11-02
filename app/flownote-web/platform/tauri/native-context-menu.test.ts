import { describe, expect, it } from 'vitest';
import { nativeMenuPositionBelowEnd, nativeMenuWidth } from './native-context-menu';

describe('native context menu helpers', () => {
  it('keeps native menu width calibration in one place', () => {
    expect(nativeMenuWidth('conversation')).toBe(120);
    expect(nativeMenuWidth('documentActions')).toBe(192);
  });

  it('aligns a popup to the element right edge and clamps the left edge', () => {
    const element = {
      getBoundingClientRect: () => ({ right: 180, bottom: 64 }),
    } as Element;

    expect(nativeMenuPositionBelowEnd(element, 200)).toEqual({ x: 4, y: 76 });
    expect(nativeMenuPositionBelowEnd(element, 120, 8)).toEqual({ x: 60, y: 72 });
  });
});
