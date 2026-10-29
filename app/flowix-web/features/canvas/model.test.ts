import { describe, expect, it } from 'vitest';
import {
  CANVAS_DOCUMENT_TYPE,
  CanvasParseError,
  canvasFileNameFor,
  createCanvasDocumentText,
  dataUrlPayload,
  isCanvasFilePath,
  parseCanvasDocument,
  readCanvasFileEntries,
  readPersistedAppState,
  readBoardCards,
  readBoardEdges,
  readBoardFrames,
  readBoardInk,
  readBoardShapes,
  readBoardViewport,
  serializeCanvasDocument,
} from './model';

describe('isCanvasFilePath', () => {
  it('matches the .flowix-canvas extension case-insensitively', () => {
    expect(isCanvasFilePath('/notebook/Ideas.flowix-canvas')).toBe(true);
    expect(isCanvasFilePath('/notebook/Ideas.FLOWIX-CANVAS')).toBe(true);
    expect(isCanvasFilePath('/notebook/Ideas.canvas')).toBe(false);
    expect(isCanvasFilePath('/notebook/Ideas.md')).toBe(false);
  });
});

describe('parseCanvasDocument', () => {
  it('round-trips a created document', () => {
    const document = parseCanvasDocument(createCanvasDocumentText());
    expect(document.type).toBe(CANVAS_DOCUMENT_TYPE);
    expect(document.version).toBe(1);
    expect(document.elements).toEqual([]);
    expect(document.cards).toEqual([]);
    expect(document.files).toEqual({});
  });

  it('rejects non-JSON and foreign documents', () => {
    expect(() => parseCanvasDocument('not json')).toThrow(CanvasParseError);
    expect(() => parseCanvasDocument('{"type":"application/json"}')).toThrow(CanvasParseError);
    expect(() => parseCanvasDocument('{"type":"flowix/canvas","version":2}')).toThrow(CanvasParseError);
  });

  it('keeps only plain-object elements and defaults missing collections', () => {
    const text = JSON.stringify({
      type: 'flowix/canvas',
      version: 1,
      elements: [{ id: 'a', type: 'rectangle' }, 'garbage', 42],
      files: { img_1: { dataURL: 'data:image/png;base64,AA' } },
    });
    const document = parseCanvasDocument(text);
    expect(document.elements).toEqual([{ id: 'a', type: 'rectangle' }]);
    expect(Object.keys(document.files)).toEqual(['img_1']);
    expect(document.meta.createdAt).toBeTruthy();
  });
});

describe('readPersistedAppState', () => {
  it('restores only whitelisted fields', () => {
    const document = parseCanvasDocument(JSON.stringify({
      type: 'flowix/canvas',
      version: 1,
      appState: { viewBackgroundColor: '#fafafa', gridSize: 20, gridModeEnabled: true, scrollX: 12 },
    }));
    expect(readPersistedAppState(document)).toEqual({
      viewBackgroundColor: '#fafafa', gridSize: 20, gridModeEnabled: true,
    });
  });
});

describe('serializeCanvasDocument', () => {
  it('merges live state and refreshes updatedAt', () => {
    const document = parseCanvasDocument(createCanvasDocumentText());
    const before = document.meta.updatedAt;
    const { text } = serializeCanvasDocument(
      document,
      [{ id: 'a', type: 'rectangle' }],
      { viewBackgroundColor: '#ffffff' },
      {},
    );
    const parsed = JSON.parse(text);
    expect(parsed.elements).toEqual([{ id: 'a', type: 'rectangle' }]);
    expect(parsed.appState).toEqual({ viewBackgroundColor: '#ffffff' });
    expect(parsed.cards).toEqual([]);
    expect(parsed.meta.createdAt).toBe(document.meta.createdAt);
    expect(parsed.meta.updatedAt >= before).toBe(true);
  });

  it('drops oversized bitmaps and reports the count', () => {
    const document = parseCanvasDocument(createCanvasDocumentText());
    const small = { dataURL: 'data:image/png;base64,AA' };
    const huge = { dataURL: `data:image/png;base64,${'A'.repeat(3 * 1024 * 1024)}` };
    const { droppedFileCount } = serializeCanvasDocument(document, [], {}, { keep: small, drop: huge });
    expect(droppedFileCount).toBe(1);
    const parsed = JSON.parse(serializeCanvasDocument(document, [], {}, { keep: small, drop: huge }).text);
    expect(Object.keys(parsed.files)).toEqual(['keep']);
  });
});

describe('externalized bitmaps', () => {
  it('persists a storage key instead of the inline data URL', () => {
    const document = parseCanvasDocument(createCanvasDocumentText());
    const { text } = serializeCanvasDocument(
      document,
      [],
      {},
      { img1: { id: 'img1', mimeType: 'image/png', dataURL: 'data:image/png;base64,AAAA' } },
      new Map([['img1', 'attachments/img1.png']]),
    );
    const parsed = JSON.parse(text);
    expect(parsed.files.img1).toEqual({ id: 'img1', mimeType: 'image/png', storageKey: 'attachments/img1.png' });
  });

  it('reads entries written with a key or as legacy inline data', () => {
    const entries = readCanvasFileEntries({
      a: { id: 'a', mimeType: 'image/png', storageKey: 'attachments/a.png' },
      b: { id: 'b', mimeType: 'image/jpeg', dataURL: 'data:image/jpeg;base64,BBBB' },
      broken: { dataURL: 'not-a-data-url' },
    });
    expect(entries).toEqual([
      { id: 'a', mimeType: 'image/png', storageKey: 'attachments/a.png' },
      { id: 'b', mimeType: 'image/jpeg', dataURL: 'data:image/jpeg;base64,BBBB' },
    ]);
  });

  it('derives payloads, file names and extensions', () => {
    expect(dataUrlPayload('data:image/png;base64,AAAA')).toBe('AAAA');
    expect(dataUrlPayload('https://example.com/a.png')).toBeNull();
    expect(canvasFileNameFor('img1', 'image/jpeg')).toBe('img1.jpg');
    expect(canvasFileNameFor('img1', 'image/svg+xml')).toBe('img1.svg');
    expect(canvasFileNameFor('img1', 'application/octet-stream')).toBe('img1.png');
  });
});

describe('serialization keeps persisted references', () => {
  it('never drops an entry the live scene could not hydrate', () => {
    const document = parseCanvasDocument(JSON.stringify({
      type: 'flowix/canvas',
      version: 1,
      elements: [],
      files: { img1: { id: 'img1', mimeType: 'image/png', storageKey: 'attachments/img1.png' } },
    }));
    // Live scene has no hydrated file for img1 (attachment not synced yet).
    const { text } = serializeCanvasDocument(document, [], {}, {}, new Map());
    const parsed = JSON.parse(text);
    expect(parsed.files.img1).toEqual({ id: 'img1', mimeType: 'image/png', storageKey: 'attachments/img1.png' });
  });
});

describe('updatedAt stability', () => {
  it('keeps updatedAt when touchUpdatedAt is false so opens are not edits', () => {
    const document = parseCanvasDocument(JSON.stringify({
      type: 'flowix/canvas', version: 1,
      meta: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' },
      elements: [], files: {},
    }));
    const { text } = serializeCanvasDocument(document, [], {}, {}, undefined, { touchUpdatedAt: false });
    expect(JSON.parse(text).meta.updatedAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('stamps a fresh updatedAt by default', () => {
    const document = parseCanvasDocument(JSON.stringify({
      type: 'flowix/canvas', version: 1,
      meta: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' },
      elements: [], files: {},
    }));
    const { text } = serializeCanvasDocument(document, [], {}, {});
    expect(JSON.parse(text).meta.updatedAt).not.toBe('2026-01-02T00:00:00.000Z');
  });
});

describe('board layer', () => {
  const boardText = JSON.stringify({
    type: 'flowix/canvas',
    version: 1,
    elements: [],
    cards: [
      { id: 'c1', kind: 'note', x: 0, y: 0, w: 320, h: 220, notebookId: 'nb1', path: 'research/a.md', title: 'A' },
      { id: 'c2', kind: 'text', x: 10, y: 10, w: 240, h: 150, text: 'sticky' },
      { id: 'c3', kind: 'image', x: 20, y: 20, w: 320, h: 220, fileId: 'img1' },
      { id: 'bad', x: 'oops', y: 0, w: 10, h: 10 },
    ],
    shapes: [{ id: 's1', shape: 'rect', x: 0, y: 0, w: 10, h: 10 }],
    ink: [{ id: 'k1', points: [[0, 0]] }],
    edges: [{ id: 'e1', from: 'c1', to: 'c2' }],
    frames: [{ id: 'f1', title: 'Q4', x: -40, y: -40, w: 900, h: 700 }],
    files: { img1: { id: 'img1', mimeType: 'image/png', storageKey: 'attachments/img1.png' } },
    appState: { viewport: { x: 12, y: -3, zoom: 0.8 } },
  });

  it('parses board collections and typed readers coerce entries', () => {
    const document = parseCanvasDocument(boardText);
    expect(readBoardCards(document).map((card) => card.id)).toEqual(['c1', 'c2', 'c3']);
    expect(readBoardCards(document)[0]).toMatchObject({ kind: 'note', notebookId: 'nb1', path: 'research/a.md' });
    expect(readBoardCards(document)[1].kind).toBe('text');
    expect(readBoardEdges(document)).toEqual([{ id: 'e1', from: 'c1', to: 'c2' }]);
    expect(readBoardFrames(document)[0]).toMatchObject({ id: 'f1', title: 'Q4' });
    expect(readBoardViewport(document)).toEqual({ x: 12, y: -3, zoom: 0.8 });
  });

  it('defaults unknown card kinds to note and drops malformed entries', () => {
    const document = parseCanvasDocument(JSON.stringify({
      type: 'flowix/canvas', version: 1,
      cards: [{ id: 'x', kind: 'mystery', x: 1, y: 2, w: 3, h: 4 }, { id: 'y' }],
    }));
    const cards = readBoardCards(document);
    expect(cards).toHaveLength(1);
    expect(cards[0].kind).toBe('note');
  });

  it('keeps board collections and viewport across a serialize round-trip', () => {
    const document = parseCanvasDocument(boardText);
    const { text } = serializeCanvasDocument(
      document, document.elements, readPersistedAppState(document), document.files,
      new Map([['img1', 'attachments/img1.png']]), { touchUpdatedAt: false },
    );
    const parsed = JSON.parse(text);
    expect(parsed.cards).toHaveLength(4);
    expect(parsed.shapes).toEqual([{ id: 's1', shape: 'rect', x: 0, y: 0, w: 10, h: 10 }]);
    expect(parsed.ink).toEqual([{ id: 'k1', points: [[0, 0]] }]);
    expect(parsed.edges).toEqual([{ id: 'e1', from: 'c1', to: 'c2' }]);
    expect(parsed.frames).toHaveLength(1);
    expect(parsed.appState.viewport).toEqual({ x: 12, y: -3, zoom: 0.8 });
    expect(parsed.files.img1).toEqual({ id: 'img1', mimeType: 'image/png', storageKey: 'attachments/img1.png' });
  });

  it('drops an invalid viewport instead of failing the file', () => {
    const document = parseCanvasDocument(JSON.stringify({
      type: 'flowix/canvas', version: 1,
      appState: { viewport: { x: 1, y: 2, zoom: 0 } },
    }));
    expect(readBoardViewport(document)).toBeNull();
  });

  it('a document without cards routes to the board renderer', () => {
    const document = parseCanvasDocument(createCanvasDocumentText());
    expect(readBoardCards(document)).toHaveLength(0);
  });
});

describe('board ink layer', () => {
  it('reads valid strokes and drops malformed ones', () => {
    const document = parseCanvasDocument(JSON.stringify({
      type: 'flowix/canvas', version: 1,
      ink: [
        { id: 'k1', points: [[0, 0], [10, 4], [20, 8]], color: '#3b82f6', width: 5 },
        { id: 'bad', points: [[0, 0]], color: '#fff', width: 2 },
        { id: 'k2', points: [[1, 1], 'x', [3, 3]], color: '#ef4444', width: 0 },
        'garbage',
      ],
    }));
    const strokes = readBoardInk(document);
    expect(strokes).toHaveLength(1);
    expect(strokes[0]).toMatchObject({ id: 'k1', color: '#3b82f6', width: 5 });
    expect(strokes[0].points).toEqual([[0, 0], [10, 4], [20, 8]]);
  });

  it('survives a serialize round-trip', () => {
    const document = parseCanvasDocument(JSON.stringify({
      type: 'flowix/canvas', version: 1,
      ink: [{ id: 'k1', points: [[1, 2], [3, 4]], color: '#111827', width: 10 }],
    }));
    const { text } = serializeCanvasDocument(document, document.elements, {}, document.files, new Map(), { touchUpdatedAt: false });
    expect(JSON.parse(text).ink).toEqual([{ id: 'k1', points: [[1, 2], [3, 4]], color: '#111827', width: 10 }]);
  });
});

describe('board shapes', () => {
  it('reads valid shapes and drops malformed entries', () => {
    const document = parseCanvasDocument(JSON.stringify({
      type: 'flowix/canvas', version: 1,
      shapes: [
        { id: 's1', shape: 'rect', x: 0, y: 0, w: 160, h: 100, stroke: '#3b82f6', text: '网关' },
        { id: 's2', shape: 'ellipse', x: 10, y: 10, w: 80, h: 60 },
        { id: 's3', shape: 'weird', x: 0, y: 0, w: 40, h: 40 },
        { id: 'bad', shape: 'rect', x: 'nope', y: 0, w: 10, h: 10 },
      ],
    }));
    const shapes = readBoardShapes(document);
    expect(shapes.map((shape) => shape.shape)).toEqual(['rect', 'ellipse', 'rect']);
    expect(shapes[0]).toMatchObject({ id: 's1', stroke: '#3b82f6', text: '网关' });
  });

  it('survives a serialize round-trip', () => {
    const document = parseCanvasDocument(JSON.stringify({
      type: 'flowix/canvas', version: 1,
      shapes: [{ id: 's1', shape: 'diamond', x: 1, y: 2, w: 120, h: 80, text: '判断' }],
    }));
    const { text } = serializeCanvasDocument(document, document.elements, {}, document.files, new Map(), { touchUpdatedAt: false });
    expect(JSON.parse(text).shapes).toEqual([{ id: 's1', shape: 'diamond', x: 1, y: 2, w: 120, h: 80, text: '判断' }]);
  });
});

describe('board shape styling', () => {
  it('reads stroke width/style, fill and label size', () => {
    const document = parseCanvasDocument(JSON.stringify({
      type: 'flowix/canvas', version: 1,
      shapes: [
        { id: 's1', shape: 'rect', x: 0, y: 0, w: 100, h: 80, stroke: '#ef4444', fill: '#fee2e2', strokeWidth: 4, strokeStyle: 'dashed' },
        { id: 's2', shape: 'text', x: 0, y: 0, w: 200, h: 40, text: 'hello', fontSize: 28 },
        { id: 's3', shape: 'rect', x: 0, y: 0, w: 10, h: 10, strokeStyle: 'wavy', strokeWidth: -1 },
      ],
    }));
    const shapes = readBoardShapes(document);
    expect(shapes[0]).toMatchObject({ strokeWidth: 4, strokeStyle: 'dashed', fill: '#fee2e2' });
    expect(shapes[1]).toMatchObject({ shape: 'text', fontSize: 28 });
    expect(shapes[2].strokeStyle).toBeUndefined();
    expect(shapes[2].strokeWidth).toBeUndefined();
  });
});

describe('board shape opacity', () => {
  it('clamps opacity into 1-100 and defaults to opaque', () => {
    const document = parseCanvasDocument(JSON.stringify({
      type: 'flowix/canvas', version: 1,
      shapes: [
        { id: 'a', shape: 'rect', x: 0, y: 0, w: 10, h: 10, opacity: 250 },
        { id: 'b', shape: 'rect', x: 0, y: 0, w: 10, h: 10, opacity: 40 },
        { id: 'c', shape: 'rect', x: 0, y: 0, w: 10, h: 10 },
      ],
    }));
    const shapes = readBoardShapes(document);
    expect(shapes[0].opacity).toBe(100);
    expect(shapes[1].opacity).toBe(40);
    expect(shapes[2].opacity).toBeUndefined();
  });
});
