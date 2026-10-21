import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useMembershipAccess } from './membership';

const mocks = vi.hoisted(() => ({ state: {
  revision: 1, authenticated: true,
  membership: { active: false, expiresAt: 2000, features: {} as Record<string, boolean> },
} }));
vi.mock('@features/preferences/hooks/use-cloud-account-state', () => ({
  useCloudAccountState: () => ({ state: mocks.state, membershipLoading: false, membershipError: null }),
}));
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
function Harness() {
  const membership = useMembershipAccess();
  return <div>{membership.active ? 'member' : 'regular'}</div>;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  mocks.state = { revision: 1, authenticated: true,
    membership: { active: false, expiresAt: 2000, features: {} } };
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
});
it('uses a newly refreshed membership immediately and removes it on logout', async () => {
  await act(async () => root.render(<Harness />));
  expect(container.textContent).toBe('regular');
  mocks.state = { ...mocks.state, revision: 2, membership: { active: true, expiresAt: 2000, features: {} } };
  await act(async () => root.render(<Harness />));
  expect(container.textContent).toBe('member');
  mocks.state = { ...mocks.state, revision: 3, authenticated: false };
  await act(async () => root.render(<Harness />));
  expect(container.textContent).toBe('regular');
});
it('locks member features at expiry without waiting for another cloud response', async () => {
  mocks.state.membership.active = true;
  await act(async () => root.render(<Harness />));
  expect(container.textContent).toBe('member');
  await act(async () => vi.advanceTimersByTime(1001));
  expect(container.textContent).toBe('regular');
});
