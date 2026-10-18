'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '@/lib/error-message';
import { cloud, listenToCloudStateChanges, type CloudState } from '@platform/tauri/client';

const MEMBERSHIP_FOCUS_REFRESH_INTERVAL_MS = 30_000;

type MembershipRefreshResult = 'refreshed' | 'failed' | 'stale' | 'skipped';

export function useCloudAccountState() {
  const [state, setState] = useState<CloudState | null>(null);
  const [membershipLoading, setMembershipLoading] = useState(false);
  const [membershipError, setMembershipError] = useState<string | null>(null);
  const membershipRequest = useRef(0);
  const membershipInFlight = useRef<{ userId: string; promise: Promise<MembershipRefreshResult> } | null>(null);
  const lastMembershipRefresh = useRef<{ userId: string; at: number } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const applyState = useCallback((next: CloudState) => {
    setState((current) => !current || next.revision >= current.revision ? next : current);
    setLoadError(null);
  }, []);

  useEffect(() => {
    let active = true;
    let receivedState = false;
    const receive = (next: CloudState) => {
      if (!active) return;
      receivedState = true;
      applyState(next);
    };
    const refreshSnapshot = () => {
      if (!active) return;
      void cloud.getState().then(receive).catch((error) => {
        if (active && !receivedState) setLoadError(errorMessage(error));
      });
    };
    // Re-query after the native listener is ready (or recovers) to cover
    // events emitted while the asynchronous native subscription was pending.
    const unlisten = listenToCloudStateChanges(receive, { onListenerReady: refreshSnapshot });
    refreshSnapshot();
    return () => { active = false; unlisten(); };
  }, [applyState]);

  const refreshMembership = useCallback(async (force = true): Promise<MembershipRefreshResult> => {
    if (!state?.authenticated) return 'skipped';
    const userId = state.account?.user.id ?? '';
    if (membershipInFlight.current?.userId === userId) return membershipInFlight.current.promise;
    const now = Date.now();
    if (!force && lastMembershipRefresh.current?.userId === userId &&
      now - lastMembershipRefresh.current.at < MEMBERSHIP_FOCUS_REFRESH_INTERVAL_MS) return 'skipped';
    lastMembershipRefresh.current = { userId, at: now };
    const request = ++membershipRequest.current;
    setMembershipLoading(true);
    setMembershipError(null);
    const promise = (async (): Promise<MembershipRefreshResult> => {
      try {
        await cloud.refreshMembership();
        return request === membershipRequest.current ? 'refreshed' : 'stale';
      } catch (error) {
        if (request !== membershipRequest.current) return 'stale';
        setMembershipError(errorMessage(error));
        return 'failed';
      } finally {
        if (request === membershipRequest.current) setMembershipLoading(false);
      }
    })();
    membershipInFlight.current = { userId, promise };
    try { return await promise; }
    finally {
      if (membershipInFlight.current?.promise === promise) membershipInFlight.current = null;
    }
  }, [state?.authenticated, state?.account?.user.id]);

  useEffect(() => {
    setMembershipError(null);
    setMembershipLoading(false);
    if (!state?.authenticated) {
      lastMembershipRefresh.current = null;
      membershipInFlight.current = null;
      return;
    }
    void refreshMembership(false);
    const refresh = () => { void refreshMembership(false); };
    window.addEventListener('focus', refresh);
    return () => {
      ++membershipRequest.current;
      window.removeEventListener('focus', refresh);
    };
  }, [refreshMembership]);

  return {
    state,
    loadError,
    membershipLoading,
    membershipError,
    refreshMembership,
    applyState,
    loading: (!state && !loadError) || state?.authStatus === 'restoring',
  };
}
