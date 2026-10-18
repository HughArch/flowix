import { describe, expect, it, vi } from 'vitest';
import { openDocumentLocalLink } from './open-document-local-link';
import { peekAgentLocationRequest, cancelAgentLocationRequest } from './agent-location-navigation';

const openWorkspaceSurface = vi.hoisted(() => vi.fn());
vi.mock('@features/workspace/public/open-surface-api', () => ({ openWorkspaceSurface }));

describe('openDocumentLocalLink', () => {
  it('opens the target and publishes an anchor request for the opened host', async () => {
    openWorkspaceSurface.mockResolvedValueOnce({ status: 'opened', host: 'main-third', location: { host: 'main-third', state: 'active' } });
    await openDocumentLocalLink({ path: '/nb/课程/任务记录.md', anchor: '实验步骤' }, '/nb/课程');
    expect(openWorkspaceSurface).toHaveBeenCalledWith({
      host: 'main-third',
      target: { kind: 'external', path: '/nb/课程/任务记录.md', scopePath: '/nb/课程', transitionId: null },
    });
    const request = peekAgentLocationRequest('/nb/课程/任务记录.md');
    expect(request?.anchor).toBe('实验步骤');
    expect(request?.host).toBe('main-third');
    expect(request?.viewId).toBe('main-third');
    cancelAgentLocationRequest('/nb/课程/任务记录.md');
  });

  it('publishes the Work location for its explicit Work request', async () => {
    openWorkspaceSurface.mockResolvedValueOnce({ status: 'activated', host: 'main-third', location: { host: 'main-third', state: 'active' } });
    await openDocumentLocalLink({ path: '/nb/课程/任务记录.md', anchor: '结论' }, null);
    const request = peekAgentLocationRequest('/nb/课程/任务记录.md');
    expect(request?.host).toBe('main-third');
    expect(request?.viewId).toBe('main-third');
    cancelAgentLocationRequest('/nb/课程/任务记录.md');
  });

  it('publishes nothing without an anchor', async () => {
    openWorkspaceSurface.mockResolvedValueOnce({ status: 'opened', host: 'main-third', location: { host: 'main-third', state: 'active' } });
    await openDocumentLocalLink({ path: '/nb/方案.md', anchor: null }, '/nb');
    expect(peekAgentLocationRequest('/nb/方案.md')).toBeNull();
  });

  it('publishes nothing when navigation is cancelled', async () => {
    openWorkspaceSurface.mockResolvedValueOnce({ status: 'cancelled', host: 'main-third', reason: 'navigation-cancelled' });
    await openDocumentLocalLink({ path: '/nb/方案.md', anchor: '结论' }, '/nb');
    expect(peekAgentLocationRequest('/nb/方案.md')).toBeNull();
  });
});
