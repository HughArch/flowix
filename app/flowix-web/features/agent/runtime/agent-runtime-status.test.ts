import { describe, expect, it } from 'vitest';

import {
  normalizeAgentRuntimeStatus,
  normalizeAgentRuntimeStatusByType,
} from './agent-runtime-status';

describe('normalizeAgentRuntimeStatus', () => {
  it('distinguishes an unchecked runtime from a runtime being checked', () => {
    expect(normalizeAgentRuntimeStatus(undefined)).toEqual({
      state: 'unknown',
      reason: null,
    });
    expect(normalizeAgentRuntimeStatus(undefined, true)).toEqual({
      state: 'checking',
      reason: null,
    });
  });

  it('maps a missing installation to not-installed', () => {
    expect(normalizeAgentRuntimeStatus({
      installation: 'missing',
      readiness: 'unknown',
      reason: 'CLI not configured',
    })).toEqual({
      state: 'not-installed',
      reason: 'CLI not configured',
    });
  });

  it('keeps installed-but-unready distinct from not-installed', () => {
    expect(normalizeAgentRuntimeStatus({
      installation: 'installed',
      readiness: 'blocked',
      reason: 'No model configured',
    })).toEqual({
      state: 'not-ready',
      reason: 'No model configured',
    });
  });

  it('keeps unknown detection separate from a missing installation', () => {
    expect(normalizeAgentRuntimeStatus({
      installation: 'unknown',
      readiness: 'unknown',
      reason: 'Detection pending',
    })).toEqual({
      state: 'unknown',
      reason: 'Detection pending',
    });
    expect(normalizeAgentRuntimeStatus({
      installation: 'installed',
      readiness: 'ready',
    })).toEqual({ state: 'ready', reason: null });
  });
});

describe('normalizeAgentRuntimeStatusByType', () => {
  it('normalizes the known entries without inventing missing entries', () => {
    expect(normalizeAgentRuntimeStatusByType({
      codex: { installation: 'installed', readiness: 'ready' },
      claude: { installation: 'installed', readiness: 'blocked', reason: 'Needs setup' },
    })).toEqual({
      codex: { state: 'ready', reason: null },
      claude: { state: 'not-ready', reason: 'Needs setup' },
    });
  });
});
