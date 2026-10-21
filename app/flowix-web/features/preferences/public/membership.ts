import { useEffect, useState } from 'react';
import { useCloudAccountState } from '@features/preferences/hooks/use-cloud-account-state';
import { isMembershipActive } from '@/lib/membership';

/** Account-level access shared by all member-only features. */
export function useMembershipAccess() {
  const { state, membershipError, membershipLoading } = useCloudAccountState();
  const [now, setNow] = useState(Date.now);
  const expiresAt = state?.membership?.expiresAt;
  useEffect(() => {
    setNow(Date.now());
    if (expiresAt == null) return;
    const timer = window.setTimeout(() => setNow(Date.now()),
      Math.min(Math.max(0, expiresAt - Date.now() + 1), 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [expiresAt, state?.revision]);
  const active = Boolean(state?.authenticated && !membershipError
    && isMembershipActive(state.membership, Math.max(now, Date.now())));
  return {
    active,
    lifetime: active && state?.membership?.features?.lifetime === true,
    loading: membershipLoading,
    error: membershipError,
  };
}
