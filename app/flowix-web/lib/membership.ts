/** Shared account membership check for every member-only feature. */
export function isMembershipActive(membership: {
  active: boolean;
  startsAt?: number | null;
  expiresAt?: number | null;
} | null | undefined, now = Date.now()): boolean {
  return Boolean(membership?.active
    && (membership.startsAt == null || membership.startsAt <= now)
    && membership.expiresAt != null && membership.expiresAt > now);
}
