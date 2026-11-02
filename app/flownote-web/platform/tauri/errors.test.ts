import { describe, expect, it } from 'vitest';
import { hasTauriErrorCode, tauriErrorMessage } from './errors';

describe('tauriErrorMessage', () => {
  it('reads Error and object messages', () => {
    expect(tauriErrorMessage(new Error('boom'))).toBe('boom');
    expect(tauriErrorMessage({ message: 'structured' })).toBe('structured');
    expect(tauriErrorMessage(undefined)).toBe('');
  });
});

describe('hasTauriErrorCode', () => {
  it('matches structured codes and message substrings', () => {
    expect(hasTauriErrorCode({ code: 'PATH_NOT_EMPTY' }, 'PATH_NOT_EMPTY')).toBe(true);
    expect(hasTauriErrorCode(new Error('failed: NOTEBOOK_NOT_FOUND'), 'NOTEBOOK_NOT_FOUND')).toBe(true);
    expect(hasTauriErrorCode(new Error('other'), 'PATH_NOT_EMPTY')).toBe(false);
  });
});
