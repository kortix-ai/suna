// "Last sync" derivation for Directory Sync surfaces. Kortix is the SCIM
// SERVER — the IdP calls us — so the honest sync signal we own is "when did
// the IdP last make an authenticated SCIM request" (the backend stamps
// last_used_at on every validated call, including no-change reconciliation
// reads). We can never know when the IdP will call NEXT; the UI pairs this
// timestamp with a per-provider cadence hint instead of guessing.

import type { ScimToken } from './iam-client';

/**
 * Newest last_used_at across ACTIVE tokens — the "last sync activity" shown on
 * the SCIM card and the wizard's verify panel. Revoked/expired tokens are
 * excluded: their history says nothing about whether the IdP can still reach
 * us (a rotated-away token's recent use would fake a healthy connection).
 */
export function latestScimSyncAt(tokens: ScimToken[]): string | null {
  let max: string | null = null;
  for (const t of tokens) {
    if (t.status !== 'active' || !t.last_used_at) continue;
    const ts = new Date(t.last_used_at).getTime();
    if (Number.isNaN(ts)) continue;
    if (!max || ts > new Date(max).getTime()) max = t.last_used_at;
  }
  return max;
}

/**
 * Freshness bucket for tinting the indicator. Deliberately conservative:
 * event-driven IdPs (Okta/OneLogin/JumpCloud) only call when something
 * CHANGED, so a long quiet period is normal, not an outage — 'quiet' is a
 * fact to display, never an alarm. Only 'never' (tokens exist but the IdP
 * has not connected once) suggests a misconfiguration worth flagging.
 *
 *  - live:   < 5 min — a sync cycle is happening or just finished
 *  - recent: < 60 min — within Entra's ~40-minute scheduled cycle + slack
 *  - quiet:  older — expected for event-driven IdPs with no changes
 *  - never:  no active token has ever been used
 */
export type ScimSyncFreshness = 'live' | 'recent' | 'quiet' | 'never';

export function scimSyncFreshness(
  lastSyncAt: string | null,
  now: number = Date.now(),
): ScimSyncFreshness {
  if (!lastSyncAt) return 'never';
  const ts = new Date(lastSyncAt).getTime();
  if (Number.isNaN(ts)) return 'never';
  const age = now - ts;
  if (age < 5 * 60_000) return 'live';
  if (age < 60 * 60_000) return 'recent';
  return 'quiet';
}
