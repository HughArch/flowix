import { describe, expect, it } from 'vitest';
import {
  CANVAS_DOCUMENT_TYPE,
  CanvasParseError,
  createCanvasDocumentText,
  isCanvasFilePath,
  parseCanvasDocument,
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
