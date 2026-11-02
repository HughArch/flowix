import { describe, expect, it } from 'vitest';

import { pickFirstAvailableAgent } from './agent-types';

describe('pickFirstAvailableAgent', () => {
  it('uses the requested priority when several runtimes are available', () => {
    expect(pickFirstAvailableAgent({
      'dsh': { available: true },
      opencode: { available: true },
      claudecode: { available: true },
      codex: { available: true },
    })).toBe('dsh');
  });

  it('falls through unavailable runtimes in priority order', () => {
    expect(pickFirstAvailableAgent({
      claudecode: { available: true },
      opencode: { available: true },
      'dsh': { available: false },
    })).toBe('claudecode');
  });

  it('returns DeepSeek Harness when it is the only preferred runtime', () => {
    expect(pickFirstAvailableAgent({
      'dsh': { available: true },
    })).toBe('dsh');
  });

  it('returns null when no runtime is available', () => {
    expect(pickFirstAvailableAgent({
      codex: { available: false },
      opencode: { available: false },
    })).toBeNull();
  });
});
