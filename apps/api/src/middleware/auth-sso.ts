import { createHash } from 'node:crypto';
import { extractSsoProviderId, syncSsoMembership } from '../iam/sso-sync';

/**
 * Run SAML JIT provisioning for a Supabase-authenticated request. Cheap no-op
 * when the JWT isn't from a SAML provider (returns before any DB work).
 *
 * MUST be called on EVERY Supabase-JWT success path — local AND network
 * verification, in BOTH supabaseAuth and combinedAuth. A token that fails local
 * (JWKS) verification falls back to the network `getUser()` path, and the
 * dashboard also hits combinedAuth routes; if the sync lives on only one of
 * those paths, SSO users whose requests take a different path are never
 * provisioned into their org. Never fails the request — the user already
 * authenticated; sync errors are logged for ops review.
 *
 * A successful sync is remembered per (user, IdP, login session, claims) for
 * `SSO_SYNC_MEMO_TTL_MS`. The claims only change when the IdP issues a new
 * login, so re-running the sync on every request (one transaction, one
 * account-wide advisory lock, several email lookups) changed nothing but
 * serialized every SSO user of an account behind one lock. Membership that SCIM
 * or an admin changes does not depend on this sync; a new group mapping reaches
 * a signed-in user within one TTL.
 */
const SSO_SYNC_MEMO_TTL_MS = 5 * 60_000;
const SSO_SYNC_MEMO_MAX_ENTRIES = 10_000;
const ssoSyncMemo = new Map<string, number>();

function ssoSyncMemoKey(
  userId: string,
  email: string,
  jwtPayload: Record<string, unknown> | undefined,
): string | null {
  const providerId = extractSsoProviderId(jwtPayload);
  if (!providerId) return null;
  const loginSession = jwtPayload?.session_id ?? jwtPayload?.iat;
  if (typeof loginSession !== 'string' && typeof loginSession !== 'number') return null;
  const claims = createHash('sha256')
    .update(JSON.stringify([jwtPayload?.app_metadata ?? null, jwtPayload?.user_metadata ?? null]))
    .digest('base64url');
  return `${userId}|${providerId}|${loginSession}|${email.trim().toLowerCase()}|${claims}`;
}
/** Test hook: forget every remembered SSO sync. */
export function clearSsoSyncMemo(): void {
  ssoSyncMemo.clear();
}

export async function jitSyncSso(
  userId: string,
  email: string,
  jwtPayload: Record<string, unknown> | undefined,
): Promise<void> {
  const key = ssoSyncMemoKey(userId, email, jwtPayload);
  const now = Date.now();
  if (key) {
    const expiresAt = ssoSyncMemo.get(key);
    if (expiresAt !== undefined && expiresAt > now) return;
    ssoSyncMemo.delete(key);
  }
  try {
    await syncSsoMembership({ userId, email, jwtPayload });
    if (key) {
      if (ssoSyncMemo.size >= SSO_SYNC_MEMO_MAX_ENTRIES) {
        const oldest = ssoSyncMemo.keys().next().value;
        if (oldest !== undefined) ssoSyncMemo.delete(oldest);
      }
      ssoSyncMemo.set(key, now + SSO_SYNC_MEMO_TTL_MS);
    }
  } catch (err) {
    console.warn('[auth] SAML JIT sync failed', err);
  }
}
