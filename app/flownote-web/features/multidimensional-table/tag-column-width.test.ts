import { describe, expect, it } from 'vitest';
import { autoTagColumnWidth } from './tag-column-width';

describe('automatic tag column sizing', () => {
  it('keeps empty and short-tag columns compact, including multiple short cards', () => {
    expect(autoTagColumnWidth([], 35)).toBe(120);
    expect(autoTagColumnWidth([45, 55, 60], 35)).toBe(120);
  });

  it('fits the longest card with room for the arrow and cell padding', () => {
    expect(autoTagColumnWidth([50, 210.2], 34.8)).toBe(245);
  });

  it('caps long cards and long headers so the table scrolls rather than growing without bounds', () => {
    expect(autoTagColumnWidth([1000], 35)).toBe(320);
    expect(autoTagColumnWidth([45], 35, 350)).toBe(320);
  });
});
