import { describe, expect, it } from 'vitest';

import { isJsonFoldableLanguage, scanJsonFoldRanges } from './json-fold-scan';

const NESTED = [
  '{',
  '  "a": {',
  '    "b": 1',
  '  }',
  '}',
].join('\n');

describe('isJsonFoldableLanguage', () => {
  it('accepts the JSON family', () => {
    expect(isJsonFoldableLanguage('json')).toBe(true);
    expect(isJsonFoldableLanguage('JSONC')).toBe(true);
    expect(isJsonFoldableLanguage('json5')).toBe(true);
    expect(isJsonFoldableLanguage('javascript')).toBe(false);
    expect(isJsonFoldableLanguage(undefined)).toBe(false);
  });
});

describe('scanJsonFoldRanges', () => {
  it('finds nested container ranges', () => {
    const scan = scanJsonFoldRanges(NESTED, 'json');

    expect(scan.valid).toBe(true);
    expect(scan.ranges).toHaveLength(2);
    expect(scan.ranges[0]).toMatchObject({ openOffset: 0, openChar: '{', depth: 1 });
    expect(scan.ranges[0].hiddenStart).toBe(2);
    expect(scan.ranges[0].hiddenEnd).toBe(NESTED.lastIndexOf('}'));
    expect(scan.ranges[1]).toMatchObject({ openChar: '{', depth: 2 });
  });

  it('keeps the opener and closer lines visible', () => {
    const scan = scanJsonFoldRanges(NESTED, 'json');
    const outer = scan.ranges[0];

    expect(NESTED.slice(0, outer.hiddenStart)).toBe('{\n');
    expect(NESTED.slice(outer.hiddenEnd)).toBe('}');
  });

  it('ignores braces inside strings and escaped quotes', () => {
    const text = [
      '{',
      '  "a": "}{ \\" still string",',
      '  "b": 2',
      '}',
    ].join('\n');
    const scan = scanJsonFoldRanges(text, 'json');

    expect(scan.valid).toBe(true);
    expect(scan.ranges).toHaveLength(1);
    expect(scan.ranges[0].depth).toBe(1);
  });

  it('supports comments in jsonc', () => {
    const text = [
      '{',
      '  // a } comment',
      '  /* another } block */',
      '  "a": [1, 2]',
      '}',
    ].join('\n');
    const scan = scanJsonFoldRanges(text, 'jsonc');

    expect(scan.valid).toBe(true);
    expect(scan.ranges).toHaveLength(1);
  });

  it('marks unterminated structures invalid', () => {
    expect(scanJsonFoldRanges('{"a": 1', 'json').valid).toBe(false);
    expect(scanJsonFoldRanges('{"a": 1]', 'json').valid).toBe(false);
    expect(scanJsonFoldRanges('{\n  "a": "unterminated\n}', 'json').valid).toBe(false);
  });

  it('marks malformed json invalid but keeps jsonc structural', () => {
    expect(scanJsonFoldRanges('{\n  "a": 1,\n}', 'json').valid).toBe(false);
    expect(scanJsonFoldRanges('{\n  "a": 1,\n}', 'jsonc').valid).toBe(true);
  });

  it('does not fold single-line containers', () => {
    const scan = scanJsonFoldRanges('{"a": 1}', 'json');
    expect(scan.valid).toBe(true);
    expect(scan.ranges).toHaveLength(0);
  });

  it('skips a closer line that still holds a sibling value', () => {
    const text = [
      '{',
      '  "a": {',
      '    "b": 1',
      '  }, "c": 2',
      '}',
    ].join('\n');
    const scan = scanJsonFoldRanges(text, 'json');

    expect(scan.valid).toBe(true);
    expect(scan.ranges).toHaveLength(1);
    expect(scan.ranges[0].depth).toBe(1);
  });

  it('keeps one toggle per line and prefers the outer container', () => {
    const text = [
      '{',
      '  "a": { "nested": [',
      '    1',
      '  ] }',
      '}',
    ].join('\n');
    const scan = scanJsonFoldRanges(text, 'json');

    expect(scan.valid).toBe(true);
    expect(scan.ranges).toHaveLength(2);
    expect(scan.ranges[0].depth).toBe(1);
    expect(scan.ranges[1].depth).toBe(2);
    expect(scan.ranges[1].openChar).toBe('{');
  });

  it('rejects oversized sources', () => {
    const huge = `{"a": "${'x'.repeat(200_001)}"}`;
    expect(scanJsonFoldRanges(huge, 'json').valid).toBe(false);
  });
});
