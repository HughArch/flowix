import { describe, expect, it } from 'vitest';
import { shapeGrowBoxHeight, shapeLabelWidth } from './shape-label';

const PAD = 12;

/** Simulates the editor loop: the textarea measures `contentH`, the shape
 *  grows, the textarea re-measures (the wrap width follows the shape width,
 *  which growth never touches, so contentH stays put). The loop must settle
 *  instead of chasing floating-point dust — an earlier formula without the
 *  convergence slack froze the whole app on ellipses. */
function convergedShapeHeight(kind: Parameters<typeof shapeGrowBoxHeight>[0], height: number, contentH: number): number {
  let current = height;
  for (let i = 0; i < 64; i += 1) {
    const nextBoxH = shapeGrowBoxHeight(kind, current, contentH, PAD);
    if (nextBoxH === null) return current;
    current = nextBoxH - PAD * 2;
  }
  return Number.NaN;
}

describe('shape label growth', () => {
  it.each(['rect', 'ellipse', 'diamond'] as const)('%s converges and contains the label', (kind) => {
    for (let contentH = 8; contentH <= 400; contentH += 7) {
      for (const start of [30, 40, 100, 230.5, 360]) {
        const height = convergedShapeHeight(kind, start, contentH);
        expect(Number.isFinite(height)).toBe(true);
        const factor = kind === 'ellipse' ? 1 / Math.SQRT2 : kind === 'diamond' ? 0.5 : 1;
        // The usable band (shape × factor − 8px margin) must hold the label.
        expect(contentH).toBeLessThanOrEqual(height * factor - 8 + 0.5);
      }
    }
  });

  it('never grows arrows, lines, or a fitting label', () => {
    expect(shapeGrowBoxHeight('arrow', 40, 400, PAD)).toBeNull();
    expect(shapeGrowBoxHeight('line', 40, 400, PAD)).toBeNull();
    expect(shapeGrowBoxHeight('rect', 100, 92, PAD)).toBeNull();
    expect(shapeGrowBoxHeight('ellipse', 200, 133, PAD)).toBeNull(); // 200/√2 − 8 ≈ 133.4
  });

  it('grows a text element to hug its content', () => {
    expect(shapeGrowBoxHeight('text', 40, 120, PAD)).toBe(122);
    expect(shapeGrowBoxHeight('text', 40, 60, PAD)).toBeNull();
  });
});

describe('shapeLabelWidth', () => {
  it('wraps ellipse and diamond labels at the inscribed width', () => {
    expect(shapeLabelWidth({ shape: 'diamond', w: 358 })).toBe(171);
    expect(shapeLabelWidth({ shape: 'ellipse', w: 358 })).toBe(245);
    expect(shapeLabelWidth({ shape: 'ellipse', w: 40 })).toBe(24);
  });

  it('leaves rects, text elements, arrows and lines at the container wrap', () => {
    expect(shapeLabelWidth({ shape: 'rect', w: 358 })).toBeNull();
    expect(shapeLabelWidth({ shape: 'text', w: 358 })).toBeNull();
    expect(shapeLabelWidth({ shape: 'arrow', w: 358 })).toBeNull();
    expect(shapeLabelWidth({ shape: 'line', w: 358 })).toBeNull();
  });
});
