import { describe, expect, it } from 'vitest';
import { getPropertyIconGlyph, getPropertyIconOption } from './property-icons';

describe('getPropertyIconGlyph', () => {
  it('accepts a single emoji or character', () => {
    expect(getPropertyIconGlyph('💡')).toBe('💡');
    expect(getPropertyIconGlyph('❤️')).toBe('❤️');
    expect(getPropertyIconGlyph('🇨🇳')).toBe('🇨🇳');
    expect(getPropertyIconGlyph('书')).toBe('书');
  });

  it('rejects SVG icon ids, empty values and plain text', () => {
    expect(getPropertyIconGlyph('dog-face')).toBeNull();
    expect(getPropertyIconGlyph('dog-face.svg')).toBeNull();
    expect(getPropertyIconGlyph('')).toBeNull();
    expect(getPropertyIconGlyph('hello world')).toBeNull();
    expect(getPropertyIconGlyph('abc')).toBeNull();
    expect(getPropertyIconGlyph('两个')).toBeNull();
  });

  it('keeps SVG id resolution unchanged', () => {
    expect(getPropertyIconOption('dog-face')?.value).toBe('dog-face');
    expect(getPropertyIconOption('dog-face.svg')?.value).toBe('dog-face');
    expect(getPropertyIconOption('💡')).toBeNull();
  });
});
