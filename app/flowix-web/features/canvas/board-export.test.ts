import { describe, expect, it } from 'vitest';
import { boardToSvg } from './board-export';
import { parseCanvasDocument } from './model';

const document = parseCanvasDocument(JSON.stringify({
  type: 'flowix/canvas',
  version: 1,
  elements: [],
  cards: [
    { id: 'c1', kind: 'note', x: 0, y: 0, w: 320, h: 200, notebookId: 'nb1', path: 'a.md', title: '卡片标题' },
    { id: 'c2', kind: 'text', x: 400, y: 0, w: 200, h: 100, text: '便签内容' },
  ],
  shapes: [
    { id: 's1', shape: 'rect', x: 0, y: 300, w: 160, h: 100, text: '网关层', fill: '#d1fae5', stroke: '#3b82f6', strokeWidth: 4 },
    { id: 's2', shape: 'arrow', x: 0, y: 500, x2: 160, y2: 500, w: 160, h: 0, stroke: '#ef4444' },
    { id: 's3', shape: 'ellipse', x: 300, y: 300, w: 120, h: 80 },
  ],
  ink: [{ id: 'k1', points: [[10, 10], [40, 30], [70, 10]], color: '#10b981', width: 4 }],
  frames: [{ id: 'f1', title: '分组', x: -50, y: -50, w: 700, h: 700 }],
  files: {},
}));

describe('boardToSvg', () => {
  const svg = boardToSvg(
    document,
    new Map([['/nb/a.md', { title: '卡片标题', excerpt: '这是卡片正文摘录' }]]),
    () => '/nb/a.md',
  );

  it('emits a standalone svg with a content-sized viewBox', () => {
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toMatch(/viewBox="-?\d+(\.\d+)? -?\d+(\.\d+)? \d+(\.\d+)? \d+(\.\d+)?"/);
  });

  it('draws cards, shapes, labels, ink and frames', () => {
    expect(svg).toContain('卡片标题');
    expect(svg).toContain('这是卡片正文摘录');
    expect(svg).toContain('便签内容');
    expect(svg).toContain('网关层');
    expect(svg).toContain('<ellipse');
    expect(svg).toContain('<polygon'); // arrow head
    expect(svg).toContain('stroke-dasharray="6 6"'); // frame
    expect(svg).toContain('#10b981'); // ink stroke color
  });

  it('escapes markup in note text', () => {
    const risky = parseCanvasDocument(JSON.stringify({
      type: 'flowix/canvas', version: 1,
      cards: [{ id: 'c1', kind: 'text', x: 0, y: 0, w: 100, h: 50, text: '<script>&' }],
    }));
    const out = boardToSvg(risky, new Map(), () => null);
    expect(out).toContain('&lt;script&gt;&amp;');
    expect(out).not.toContain('<script>');
  });
});
