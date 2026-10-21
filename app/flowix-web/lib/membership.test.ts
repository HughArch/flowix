import { describe, expect, it } from 'vitest';
import { isMembershipActive } from './membership';

describe('account membership', () => {
  it('unlocks member features without a feature-specific flag or storage quota', () => {
    expect(isMembershipActive({ active: true, startsAt: 100, expiresAt: 300 }, 200)).toBe(true);
  });
  it('rejects inactive, future, expired, and unverified accounts', () => {
    expect(isMembershipActive(null, 200)).toBe(false);
    expect(isMembershipActive({ active: false, expiresAt: 300 }, 200)).toBe(false);
    expect(isMembershipActive({ active: true, startsAt: 201, expiresAt: 300 }, 200)).toBe(false);
    expect(isMembershipActive({ active: true, expiresAt: 200 }, 200)).toBe(false);
    expect(isMembershipActive({ active: true }, 200)).toBe(false);
  });
});
