import { describe, expect, it } from 'vitest';
import { blendHexColor, bucketTargetAt, parseHexColor } from './bucket-fill';
import type { BoardCard, BoardFrame, BoardShape } from './model';

const shape = (over: Partial<BoardShape>): BoardShape => ({
  id: 's', shape: 'rect', x: 0, y: 0, w: 100, h: 80, ...over,
});
const card = (over: Partial<BoardCard>): BoardCard => ({
  id: 'c', kind: 'text', x: 0, y: 0, w: 60, h: 60, ...over,
});
const frame = (over: Partial<BoardFrame>): BoardFrame => ({
  id: 'f', x: 0, y: 0, w: 300, h: 300, ...over,
});

describe('parseHexColor', () => {
  it('parses #rgb and #rrggbb, rejects the rest', () => {
    expect(parseHexColor('#fff')).toEqual([255, 255, 255]);
    expect(parseHexColor('#ffe3e3')).toEqual([255, 227, 227]);
    expect(parseHexColor('red')).toBeNull();
    expect(parseHexColor('')).toBeNull();
    expect(parseHexColor('#11223344')).toBeNull();
  });
});

describe('blendHexColor', () => {
  it('applies the paint as-is when there is no base paint', () => {
    expect(blendHexColor(null, '#ffe3e3')).toBe('#ffe3e3');
    expect(blendHexColor(undefined, '#d0ebff')).toBe('#d0ebff');
    expect(blendHexColor('transparent', '#1971c2')).toBe('#1971c2');
  });

  it('mixes two paints at half weight (overlay effect)', () => {
    expect(blendHexColor('#ffffff', '#000000')).toBe('#808080');
    expect(blendHexColor('#ffffff', '#d0ebff')).toBe('#e8f5ff');
    // #ffe3e3 (255,227,227) + #d0ebff (208,235,255) -> (232,231,241).
    expect(blendHexColor('#ffe3e3', '#d0ebff')).toBe('#e8e7f1');
  });

  it('deepens toward the bucket colour when layering repeatedly', () => {
    const first = blendHexColor('#ffffff', '#1971c2');
    const second = blendHexColor(first, '#1971c2');
    expect(second).not.toBe(first);
    const [, g1, b1] = parseHexColor(first)!;
    const [, g2, b2] = parseHexColor(second)!;
    expect(b2).toBeLessThan(b1!);
    expect(g2).toBeLessThan(g1!);
  });

  it('passes non-hex paints through untouched', () => {
    expect(blendHexColor('#ffffff', 'red')).toBe('red');
  });
});

describe('bucketTargetAt', () => {
  it('hits rect/ellipse/diamond interiors only', () => {
    const shapes = [
      shape({ id: 'r', shape: 'rect', x: 0, y: 0, w: 100, h: 80 }),
      shape({ id: 'e', shape: 'ellipse', x: 0, y: 0, w: 100, h: 80 }),
      shape({ id: 'd', shape: 'diamond', x: 0, y: 0, w: 100, h: 80 }),
    ];
    // Each kind queried alone: with a shared bbox they would overlap and the
    // later entry would win on the tie-break.
    expect(bucketTargetAt([shapes[0]], [], [], 50, 40)?.id).toBe('r');
    // A bbox corner lies outside the ellipse and the diamond outlines.
    expect(bucketTargetAt([shapes[1]], [], [], 96, 4)).toBeNull();
    expect(bucketTargetAt([shapes[2]], [], [], 96, 4)).toBeNull();
    expect(bucketTargetAt([shapes[2]], [], [], 50, 40)?.id).toBe('d');
    expect(bucketTargetAt([shapes[1]], [], [], 50, 40)?.id).toBe('e');
  });

  it('skips connectors and standalone labels', () => {
    const shapes = [
      shape({ id: 'a', shape: 'arrow', x: 0, y: 0, w: 100, h: 0, x2: 100, y2: 0 }),
      shape({ id: 'l', shape: 'line', x: 0, y: 20, w: 100, h: 0, x2: 100, y2: 20 }),
      shape({ id: 't', shape: 'text', x: 0, y: 0, w: 100, h: 40 }),
    ];
    expect(bucketTargetAt(shapes, [], [], 50, 10)).toBeNull();
  });

  it('prefers the topmost element: stickies over shapes, shapes over frames', () => {
    const shapes = [shape({ id: 'r', x: 0, y: 0, w: 100, h: 80 })];
    const stickies = [card({ id: 's1', kind: 'text', x: 10, y: 10, w: 60, h: 60 })];
    const frames = [frame({ id: 'f1', x: 0, y: 0, w: 300, h: 300 })];
    expect(bucketTargetAt(shapes, stickies, frames, 40, 40)?.id).toBe('s1');
    expect(bucketTargetAt(shapes, [], frames, 40, 40)?.id).toBe('r');
    // Only the frame covers this point.
    expect(bucketTargetAt(shapes, [], frames, 250, 250)).toMatchObject({ kind: 'frame', id: 'f1' });
  });

  it('breaks z ties by array order (later renders on top)', () => {
    const shapes = [
      shape({ id: 'under', z: 5 }),
      shape({ id: 'over', z: 5, x: 20, y: 20, w: 100, h: 80 }),
    ];
    expect(bucketTargetAt(shapes, [], [], 50, 40)?.id).toBe('over');
    // An explicit higher z wins regardless of order.
    shapes[0].z = 9;
    expect(bucketTargetAt(shapes, [], [], 50, 40)?.id).toBe('under');
  });

  it('ignores note cards', () => {
    const cards = [card({ id: 'n1', kind: 'note', x: 0, y: 0, w: 200, h: 200 })];
    expect(bucketTargetAt([], cards, [], 50, 50)).toBeNull();
  });
});
