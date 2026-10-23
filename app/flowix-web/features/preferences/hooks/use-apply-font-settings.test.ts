import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_WIDTH_DEFAULT,
  DOCUMENT_WIDTH_FULL_THRESHOLD,
  PAGE_WIDTH_SCALE_DEFAULT,
  normalizePageWidthScale,
} from '@/lib/constants';
import { resolveEditorDocumentMaxWidth } from './use-apply-font-settings';

describe('normalizePageWidthScale', () => {
  it('defaults to 100 for missing or invalid input', () => {
    expect(normalizePageWidthScale(undefined)).toBe(PAGE_WIDTH_SCALE_DEFAULT);
    expect(normalizePageWidthScale(Number.NaN)).toBe(PAGE_WIDTH_SCALE_DEFAULT);
    expect(normalizePageWidthScale('75')).toBe(PAGE_WIDTH_SCALE_DEFAULT);
  });

  it('clamps to the supported range', () => {
    expect(normalizePageWidthScale(10)).toBe(50);
    expect(normalizePageWidthScale(500)).toBe(100);
  });

  it('snaps to the slider step', () => {
    expect(normalizePageWidthScale(67)).toBe(65);
    expect(normalizePageWidthScale(68)).toBe(70);
  });
});

describe('resolveEditorDocumentMaxWidth', () => {
  it('leaves the full-width document untouched at 100%', () => {
    expect(resolveEditorDocumentMaxWidth(DOCUMENT_WIDTH_DEFAULT, 100)).toBe('100%');
  });

  it('leaves a fixed document width untouched at 100%', () => {
    expect(resolveEditorDocumentMaxWidth(800, 100)).toBe('800px');
  });

  it('scales a fixed document width', () => {
    expect(resolveEditorDocumentMaxWidth(800, 50)).toBe('calc(800px * 0.5)');
    expect(resolveEditorDocumentMaxWidth(800, 75)).toBe('calc(800px * 0.75)');
  });

  it('scales the full-width slot from the container width', () => {
    expect(resolveEditorDocumentMaxWidth(DOCUMENT_WIDTH_FULL_THRESHOLD + 50, 60))
      .toBe('calc(100% * 0.6)');
  });

  it('treats a missing scale as 100%', () => {
    expect(resolveEditorDocumentMaxWidth(800, undefined)).toBe('800px');
  });
});
