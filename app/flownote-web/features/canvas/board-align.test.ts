import { describe, expect, it } from 'vitest';
import { alignShapes, distributeShapes } from './board-align';
import type { BoardShape } from './model';

function shape(id: string, x: number, y: number, w = 100, h = 60): BoardShape {
  return { id, shape: 'rect', x, y, w, h };
}

describe('alignShapes', () => {
  it('aligns left edges on the common minimum', () => {
    const shapes = [shape('a', 0, 0), shape('b', 300, 100)];
    alignShapes(shapes, 'left');
    expect(shapes.map((shape) => shape.x)).toEqual([0, 0]);
  });

  it('centers horizontally within the selection bounds', () => {
    const shapes = [shape('a', 0, 0, 100, 60), shape('b', 400, 0, 200, 60)];
    alignShapes(shapes, 'hcenter');
    // bounds span 0..600; center of 600 is 300
    expect(shapes[0].x).toBe(250);
    expect(shapes[1].x).toBe(200);
  });

  it('aligns bottoms on the common maximum', () => {
    const shapes = [shape('a', 0, 0), shape('b', 0, 200)];
    alignShapes(shapes, 'bottom');
    // maxY = 260; a lands at 260 - 60
    expect(shapes.map((shape) => shape.y)).toEqual([200, 200]);
  });

  it('ignores single-shape selections', () => {
    const shapes = [shape('a', 0, 0)];
    alignShapes(shapes, 'left');
    expect(shapes[0].x).toBe(0);
  });
});

describe('distributeShapes', () => {
  it('evens out horizontal gaps between the outermost shapes', () => {
    const shapes = [shape('a', 0, 0, 100, 60), shape('b', 150, 0, 100, 60), shape('c', 500, 0, 100, 60)];
    distributeShapes(shapes, 'h');
    // span 0..600, total width 300, two gaps of 150
    expect(shapes.map((shape) => shape.x)).toEqual([0, 250, 500]);
  });

  it('evens out vertical gaps', () => {
    const shapes = [shape('a', 0, 0, 60, 40), shape('b', 0, 300, 60, 40), shape('c', 0, 800, 60, 40)];
    distributeShapes(shapes, 'v');
    // span 0..840, total height 120, two gaps of 360
    expect(shapes.map((shape) => shape.y)).toEqual([0, 400, 800]);
  });

  it('requires three shapes', () => {
    const shapes = [shape('a', 0, 0), shape('b', 500, 0)];
    distributeShapes(shapes, 'h');
    expect(shapes[1].x).toBe(500);
  });
});
