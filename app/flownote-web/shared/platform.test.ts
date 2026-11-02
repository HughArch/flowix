import { describe, expect, it } from 'vitest';
import { isTouchGeneratedMouseEvent } from './platform';

describe('isTouchGeneratedMouseEvent', () => {
  it('detects the synthetic mouse events a tap produces', () => {
    expect(isTouchGeneratedMouseEvent({ sourceCapabilities: { firesTouchEvents: true } })).toBe(true);
  });

  it('treats real pointer input and missing capabilities as non-touch', () => {
    expect(isTouchGeneratedMouseEvent({ sourceCapabilities: { firesTouchEvents: false } })).toBe(false);
    expect(isTouchGeneratedMouseEvent({ sourceCapabilities: null })).toBe(false);
    expect(isTouchGeneratedMouseEvent(undefined)).toBe(false);
  });
});
