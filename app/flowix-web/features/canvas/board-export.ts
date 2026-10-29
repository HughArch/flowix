/**
 * SVG/PNG export for the card board.
 *
 * The board renders through react-flow + DOM cards, so export cannot reuse the
 * live DOM. Instead this module redraws the persisted document (frames, shapes,
 * ink, note cards) into a single standalone SVG; PNG is that SVG rasterized in
 * an offscreen canvas.
 */

import { getStroke } from 'perfect-freehand';
import { roughLinePath, roughPathsFor } from './board-rough';
import {
  readBoardCards,
  readBoardEdges,
  readBoardFrames,
  readBoardInk,
  readBoardShapes,
  type BoardCard,
  type BoardShape,
  type FlowixCanvasDocument,
} from './model';

export interface BoardExportSummary {
  title: string;
  excerpt: string;
}

const PADDING = 60;
const CARD_PADDING = 10;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** perfect-freehand outline -> filled path (same helper as the live layer). */
function freehandPath(points: number[][], width: number): string {
  const outline = getStroke(points, {
    size: width * 2,
    thinning: 0.5,
    smoothing: 0.5,
    streamline: 0.5,
    simulatePressure: true,
  });
  if (outline.length < 4) return '';
  const average = (a: number, b: number) => (a + b) / 2;
  let [a, b, c] = outline;
  let path = `M${a[0]},${a[1]} Q${b[0]},${b[1]} ${average(b[0], c[0])},${average(b[1], c[1])} T`;
  for (let i = 2; i < outline.length - 1; i += 1) {
    a = outline[i];
    b = outline[i + 1];
    path += `${average(a[0], b[0])},${average(a[1], b[1])} `;
  }
  return `${path}Z`;
}

/** Greedy wrap by estimated glyph width; good enough for a static export. */
function wrapText(text: string, maxChars: number, maxLines: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let current = '';
    for (const char of paragraph) {
      current += char;
      if (current.length >= maxChars) {
        lines.push(current);
        current = '';
        if (lines.length >= maxLines) return lines;
      }
    }
    if (current) {
      lines.push(current);
      if (lines.length >= maxLines) return lines;
    }
  }
  return lines;
}

function shapeMarkup(shape: BoardShape): string {
  const stroke = shape.stroke ?? '#64748b';
  const strokeWidth = shape.strokeWidth ?? 2;

  if (shape.shape === 'arrow') {
    const x2 = shape.x2 ?? shape.x + shape.w;
    const y2 = shape.y2 ?? shape.y + shape.h;
    const angle = Math.atan2(y2 - shape.y, x2 - shape.x);
    const head = 10 + strokeWidth * 2;
    const spread = Math.PI / 7;
    const h1 = [x2 - head * Math.cos(angle - spread), y2 - head * Math.sin(angle - spread)];
    const h2 = [x2 - head * Math.cos(angle + spread), y2 - head * Math.sin(angle + spread)];
    return `<path d="${roughLinePath(shape.x, shape.y, x2, y2, shape)}" stroke="${stroke}" stroke-width="${strokeWidth}" fill="none" stroke-linecap="round"/>`
      + `<polygon points="${x2},${y2} ${h1[0]},${h1[1]} ${h2[0]},${h2[1]}" fill="${stroke}"/>`;
  }

  if (shape.shape === 'text') {
    const size = shape.fontSize ?? 16;
    const lines = wrapText(shape.text ?? '', Math.max(1, Math.floor(shape.w / (size * 0.6))), Math.max(1, Math.floor(shape.h / (size * 1.3)) + 1));
    const spans = lines.map((line, index) =>
      `<tspan x="${shape.x}" dy="${index === 0 ? 0 : size * 1.3}">${escapeXml(line)}</tspan>`).join('');
    return `<text x="${shape.x}" y="${shape.y + size}" font-size="${size}" fill="${stroke}" font-family="system-ui, sans-serif">${spans}</text>`;
  }

  const label = shape.text ? (() => {
    const size = shape.fontSize ?? 14;
    const lines = wrapText(shape.text, Math.max(1, Math.floor(shape.w / (size * 0.6))), 4);
    const startY = shape.y + shape.h / 2 - ((lines.length - 1) * size * 1.3) / 2 + size / 3;
    const spans = lines.map((line, index) =>
      `<tspan x="${shape.x + shape.w / 2}" dy="${index === 0 ? 0 : size * 1.3}">${escapeXml(line)}</tspan>`).join('');
    return `<text x="${shape.x + shape.w / 2}" y="${startY}" font-size="${size}" fill="#0f172a" text-anchor="middle" font-family="system-ui, sans-serif">${spans}</text>`;
  })() : '';

  // Same roughjs outline as the live board so exports match what users see.
  const sketch = roughPathsFor(shape)
    .map((path) => `<path d="${path.d}" stroke="${path.stroke}" stroke-width="${path.strokeWidth}" fill="${path.fill ?? 'none'}" stroke-linecap="round" stroke-linejoin="round"/>`)
    .join('');
  return `${sketch}${label}`;
}

function cardMarkup(card: BoardCard, summary: BoardExportSummary | undefined): string {
  const title = summary?.title ?? card.title ?? card.path?.split('/').pop() ?? card.id;
  const lines = summary?.excerpt ? wrapText(summary.excerpt, Math.max(4, Math.floor(card.w / 7)), 5) : [];
  const body = lines.map((line, index) =>
    `<tspan x="${card.x + CARD_PADDING}" dy="${index === 0 ? 0 : 15}">${escapeXml(line)}</tspan>`).join('');
  return `<g>
    <rect x="${card.x}" y="${card.y}" width="${card.w}" height="${card.h}" rx="10" fill="#ffffff" stroke="#d4d4d8"/>
    <line x1="${card.x}" y1="${card.y + 28}" x2="${card.x + card.w}" y2="${card.y + 28}" stroke="#e4e4e7"/>
    <text x="${card.x + CARD_PADDING}" y="${card.y + 19}" font-size="12" font-weight="600" fill="#18181b" font-family="system-ui, sans-serif">${escapeXml(title.slice(0, 40))}</text>
    <text x="${card.x + CARD_PADDING}" y="${card.y + 48}" font-size="11" fill="#52525b" font-family="system-ui, sans-serif">${body}</text>
  </g>`;
}

/** Standalone SVG for the whole board; `viewBox` is the content bounding box. */
export function boardToSvg(
  document: FlowixCanvasDocument,
  summaries: ReadonlyMap<string, BoardExportSummary>,
  absolutePathOf: (card: BoardCard) => string | null,
): string {
  const frames = readBoardFrames(document);
  const cards = readBoardCards(document);
  const shapes = readBoardShapes(document);
  const ink = readBoardInk(document);

  const xs: number[] = [];
  const ys: number[] = [];
  const push = (x: number, y: number) => { xs.push(x); ys.push(y); };
  for (const frame of frames) { push(frame.x, frame.y); push(frame.x + frame.w, frame.y + frame.h); }
  for (const card of cards) { push(card.x, card.y); push(card.x + card.w, card.y + card.h); }
  for (const shape of shapes) {
    push(shape.x, shape.y);
    push(shape.x + shape.w, shape.y + shape.h);
    if (shape.shape === 'arrow') { push(shape.x2 ?? shape.x, shape.y2 ?? shape.y); }
  }
  for (const stroke of ink) for (const point of stroke.points) push(point[0], point[1]);

  const minX = xs.length ? Math.min(...xs) : 0;
  const minY = ys.length ? Math.min(...ys) : 0;
  const maxX = xs.length ? Math.max(...xs) : 800;
  const maxY = ys.length ? Math.max(...ys) : 600;
  const width = Math.max(1, maxX - minX + PADDING * 2);
  const height = Math.max(1, maxY - minY + PADDING * 2);

  const frameMarkup = frames.map((frame) => `<g>
    <rect x="${frame.x}" y="${frame.y}" width="${frame.w}" height="${frame.h}" rx="12" fill="none" stroke="#a1a1aa" stroke-width="2" stroke-dasharray="6 6"/>
    ${frame.title ? `<text x="${frame.x}" y="${frame.y - 10}" font-size="12" fill="#52525b" font-family="system-ui, sans-serif">${escapeXml(frame.title)}</text>` : ''}
  </g>`).join('');

  const cardMarkupAll = cards.map((card) => cardMarkup(card, (() => {
    if (card.kind !== 'note') return { title: card.title ?? card.text ?? card.id, excerpt: card.text ?? '' };
    const absolute = absolutePathOf(card);
    return absolute ? summaries.get(absolute) ?? undefined : undefined;
  })())).join('');

  const shapesMarkup = shapes.map(shapeMarkup).join('');
  const inkMarkup = ink.map((stroke) =>
    `<path d="${freehandPath(stroke.points, stroke.width)}" fill="${stroke.color}"/>`).join('');

  const edgeMarkup = readBoardEdges(document).map((edge) => {
    const from = cards.find((card) => card.id === edge.from);
    const to = cards.find((card) => card.id === edge.to);
    if (!from || !to) return '';
    return `<line x1="${from.x + from.w / 2}" y1="${from.y + from.h / 2}" x2="${to.x + to.w / 2}" y2="${to.y + to.h / 2}" stroke="#a1a1aa" stroke-width="1.5"/>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${minX - PADDING} ${minY - PADDING} ${width} ${height}">
  <rect x="${minX - PADDING}" y="${minY - PADDING}" width="${width}" height="${height}" fill="#ffffff"/>
  ${frameMarkup}
  ${shapesMarkup}
  ${edgeMarkup}
  ${inkMarkup}
  ${cardMarkupAll}
</svg>`;
}

/** Rasterize an SVG string to base64 PNG via an offscreen canvas. */
export async function svgToPngBase64(svg: string): Promise<string> {
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('SVG rasterization failed'));
    image.src = url;
  });
  const canvas = document.createElement('canvas');
  canvas.width = image.width || 800;
  canvas.height = image.height || 600;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas unavailable');
  context.drawImage(image, 0, 0);
  const dataUrl = canvas.toDataURL('image/png');
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}
