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
 *   - Kortix API/sandbox tokens    (kortix_…)     → the owning account id
 *   - Supabase JWTs                               → the user's id
 * and enforces sandbox ownership via `canAccessPreviewSandbox`.
 *
 * Returns the resolved *principal id* (the value callers thread through as the
 * downstream `userId` for signing X-Kortix-User-Context), or null on any
 * failure — callers respond 401.
 */

import { isKortixToken, isAccountToken, isServiceAccountToken } from '../shared/crypto';
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
export async function authenticatePreviewPrincipal(
  token: string | null | undefined,
  sandboxId: string,
): Promise<string | null> {
  if (!token) return null;
  try {
    // CLI Personal Access Token — carries the minting user's real id.
    if (isAccountToken(token)) {
      const r = await validateAccountToken(token);
      if (!r.isValid || !r.userId) return null;
      return (await canAccessPreviewSandbox({ previewSandboxId: sandboxId, userId: r.userId }))
        ? r.userId
        : null;
    }

    // Service-account token — a non-human IAM principal (synthetic id).
    if (isServiceAccountToken(token)) {
      const r = await validateServiceAccountToken(token);
      if (!r.isValid || !r.serviceAccountId) return null;
      return (await canAccessPreviewSandbox({ previewSandboxId: sandboxId, userId: r.serviceAccountId }))
        ? r.serviceAccountId
        : null;
    }

    // Kortix API / sandbox token — ownership is checked against the account.
    if (isKortixToken(token)) {
      const r = await validateSecretKey(token);
      if (!r.isValid || !r.accountId) return null;
      return (await canAccessPreviewSandbox({ previewSandboxId: sandboxId, accountId: r.accountId }))
        ? r.accountId
        : null;
    }

    // Supabase JWT — fast local verify, network fallback only while JWKS warms.
    const local = await verifySupabaseJwt(token);
    if (local.ok) {
      return (await canAccessPreviewSandbox({ previewSandboxId: sandboxId, userId: local.userId }))
        ? local.userId
        : null;
    }
    if (local.reason !== 'no-keys' && local.reason !== 'no-key-for-kid') return null;

    const supabase = getSupabase();
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return null;
    return (await canAccessPreviewSandbox({ previewSandboxId: sandboxId, userId: user.id }))
      ? user.id
      : null;
  } catch (err) {
    console.warn('[preview-auth] token validation error:', (err as Error)?.message || err);
    return null;
  }
}

/**
 * Extract the candidate token from a preview request, in priority order:
 * Authorization: Bearer → X-Kortix-Token → ?token= → __preview_session cookie.
 * Mirrors the order used by `combinedAuth` for preview routes.
 */
export function extractPreviewToken(req: Request, url: URL): string | null {
  const authHeader = req.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);
  const ktHeader = req.headers.get('X-Kortix-Token');
  if (ktHeader) return ktHeader;
  const qp = url.searchParams.get('token');
  if (qp) return qp;
  const cookieHeader = req.headers.get('Cookie') || '';
  const m = cookieHeader.match(/(?:^|;\s*)__preview_session=([^;]+)/);
  if (m) return decodeURIComponent(m[1]);
  return null;
}
