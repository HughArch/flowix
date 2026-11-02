import { describe, expect, it } from 'vitest';

import { normalizeLatex } from './math-block';

describe('normalizeLatex', () => {
  it('accepts a bare formula', () => {
    expect(normalizeLatex(String.raw`f(x) = \frac{x^2 + 1}{\sqrt{x+2}}`))
      .toBe(String.raw`f(x) = \frac{x^2 + 1}{\sqrt{x+2}}`);
  });

  it('removes display-math brackets pasted around a formula', () => {
    expect(normalizeLatex(String.raw`\[

f(x) = \frac{x^2 + 1}{\sqrt{x+2}}

\]`)).toBe(String.raw`f(x) = \frac{x^2 + 1}{\sqrt{x+2}}`);
  });

  it('also canonicalizes dollar-wrapped and repeatedly wrapped formulas', () => {
    expect(normalizeLatex(String.raw`$$
\[
x^2
\]
$$`)).toBe('x^2');
  });
});
