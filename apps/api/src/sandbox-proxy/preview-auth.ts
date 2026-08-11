/**
 * Unified preview-token authentication.
 *
 * The preview proxy is reached three ways and each historically grew its own
 * token validator: the Hono `combinedAuth` middleware (path-based HTTP), the
 * subdomain handler, and the WebSocket upgrade. The latter two had drifted —
 * the subdomain path rejected CLI PATs and service-account tokens, the WS path
 * rejected service-account tokens — so the *same* credential could open one
 * edge of the proxy and be refused at another.
 *
 * This module is the single source of truth for "does this bare token grant
 * access to this sandbox", used by every NON-Hono edge (subdomain + WS). It
 * accepts exactly the set `combinedAuth` accepts for preview routes:
 *   - CLI Personal Access Tokens (kortix_pat_…)  → the minting user's id
 *   - Service-account tokens       (kortix_sa_…)  → the service-account id
 *   - dosco API/sandbox tokens    (kortix_…)     → the owning account id
 *   - Supabase JWTs                               → the user's id
 * and enforces sandbox ownership via `canAccessPreviewSandbox`.
 *
 * Returns the resolved *principal id* (the value callers thread through as the
 * downstream `userId` for signing X-dosco-User-Context), or null on any
 * failure — callers respond 401.
 */

import { isdoscoToken, isAccountToken, isServiceAccountToken } from '../shared/crypto';
import { validateSecretKey } from '../repositories/api-keys';
import { validateAccountToken } from '../repositories/account-tokens';
import { validateServiceAccountToken } from '../repositories/service-accounts';
import { verifySupabaseJwt } from '../shared/jwt-verify';
import { getSupabase } from '../shared/supabase';
import { canAccessPreviewSandbox } from '../shared/preview-ownership';

/**
 * Validate `token` and, if it grants access to `sandboxId`, return the
 * principal id to forward downstream. Returns null on any failure (invalid
 * token, or valid token without access to this sandbox).
 */
export interface PreviewPrincipal {
  /** The principal's id (user, service account, or account for a kortix key). */
  userId: string;
  /**
   * The session this credential is BOUND to, when it is a sandbox token. Null
   * for a laptop CLI PAT, a service account, or a JWT. dosco-as-a-Backend
   * shares one `created_by` across every end-user, so this is the only thing
   * that distinguishes one end-user's sandbox from another's.
   */
  sessionId: string | null;
}

/**
 * Same authentication as {@link authenticatePreviewPrincipal}, but also returns
 * the session the credential is bound to. Prefer this on any surface that then
 * makes a session-visibility decision.
 */
export async function authenticatePreviewPrincipalDetailed(
  token: string | null | undefined,
  sandboxId: string,
): Promise<PreviewPrincipal | null> {
  if (!token) return null;
  try {
    // CLI Personal Access Token — carries the minting user's real id, and for a
    // SANDBOX token also the session it was minted for.
    if (isAccountToken(token)) {
      const r = await validateAccountToken(token);
      if (!r.isValid || !r.userId) return null;
      return (await canAccessPreviewSandbox({ previewSandboxId: sandboxId, userId: r.userId }))
        ? { userId: r.userId, sessionId: r.sessionId ?? null }
        : null;
    }

    // Service-account token — a non-human IAM principal (synthetic id).
    if (isServiceAccountToken(token)) {
      const r = await validateServiceAccountToken(token);
      if (!r.isValid || !r.serviceAccountId) return null;
      return (await canAccessPreviewSandbox({ previewSandboxId: sandboxId, userId: r.serviceAccountId }))
        ? { userId: r.serviceAccountId, sessionId: null }
        : null;
    }

    // dosco API / sandbox token — ownership is checked against the account.
    if (isdoscoToken(token)) {
      const r = await validateSecretKey(token);
      if (!r.isValid || !r.accountId) return null;
      return (await canAccessPreviewSandbox({ previewSandboxId: sandboxId, accountId: r.accountId }))
        ? { userId: r.accountId, sessionId: null }
        : null;
    }

    // Supabase JWT — fast local verify, network fallback only while JWKS warms.
    const local = await verifySupabaseJwt(token);
    if (local.ok) {
      return (await canAccessPreviewSandbox({ previewSandboxId: sandboxId, userId: local.userId }))
        ? { userId: local.userId, sessionId: null }
        : null;
    }
    if (local.reason !== 'no-keys' && local.reason !== 'no-key-for-kid') return null;

    const supabase = getSupabase();
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return null;
    return (await canAccessPreviewSandbox({ previewSandboxId: sandboxId, userId: user.id }))
      ? { userId: user.id, sessionId: null }
      : null;
  } catch (err) {
    console.warn('[preview-auth] token validation error:', (err as Error)?.message || err);
    return null;
  }
}

/**
 * Extract the candidate token from a preview request, in priority order:
 * Authorization: Bearer → X-dosco-Token → ?token= → __preview_session cookie.
 * Mirrors the order used by `combinedAuth` for preview routes.
 */
export function extractPreviewToken(req: Request, url: URL): string | null {
  const authHeader = req.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);
  const ktHeader = req.headers.get('X-dosco-Token');
  if (ktHeader) return ktHeader;
  const qp = url.searchParams.get('token');
  if (qp) return qp;
  const cookieHeader = req.headers.get('Cookie') || '';
  const m = cookieHeader.match(/(?:^|;\s*)__preview_session=([^;]+)/);
  if (m) return decodeURIComponent(m[1]);
  return null;
}

/**
 * Back-compat wrapper: the principal id only. Existing callers that make no
 * session-scoped decision (subdomain gate) keep using this.
 */
export async function authenticatePreviewPrincipal(
  token: string | null | undefined,
  sandboxId: string,
): Promise<string | null> {
  return (await authenticatePreviewPrincipalDetailed(token, sandboxId))?.userId ?? null;
}
