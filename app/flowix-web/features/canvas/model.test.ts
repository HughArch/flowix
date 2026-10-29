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
