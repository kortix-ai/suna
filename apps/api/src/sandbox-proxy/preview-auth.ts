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
 *   - CLI Personal Access Tokens (kortix_pat_…)  → the minting user's id; a
 *     project-scoped one only for a sandbox of that project
 *     (`enforceTokenProjectScope`'s rule)
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
import { isInconclusiveVerifyFailure } from '../shared/jwt-verify-outcome';
import { getSupabase } from '../shared/supabase';
import { canAccessPreviewSandbox, resolveSandboxProjectId } from '../shared/preview-ownership';
import { bindAuditPrincipal } from '../shared/audit-scope';
import { previewActorFields } from './preview-audit';
import type { PreviewPrincipalKind } from './preview-session';

async function sandboxBelongsToProject(sandboxId: string, projectId: string): Promise<boolean> {
  const sandboxProjectId = await resolveSandboxProjectId(sandboxId);
  return sandboxProjectId !== null && sandboxProjectId === projectId;
}

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
   * for a laptop CLI PAT, a service account, or a JWT. Kortix-as-a-Backend
   * shares one `created_by` across every end-user, so this is the only thing
   * that distinguishes one end-user's sandbox from another's.
   */
  sessionId: string | null;
  /** What `userId` is. An account API key's `userId` is an ACCOUNT id. */
  principalKind: PreviewPrincipalKind;
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
      // Name the caller now, before the ownership check can refuse it.
      bindAuditPrincipal(
        previewActorFields({
          kind: 'user',
          principalId: r.userId,
          sandboxAuthored: r.sessionId != null,
          method: 'account_token',
          callerSessionId: r.sessionId ?? null,
        }),
      );
      // A project-scoped token reaches only sandboxes of its own project — the
      // same rule `enforceTokenProjectScope` applies on the Hono path form. A
      // lookup miss or another project refuses.
      if (r.projectId && !(await sandboxBelongsToProject(sandboxId, r.projectId))) return null;
      return (await canAccessPreviewSandbox({ previewSandboxId: sandboxId, userId: r.userId }))
        ? { userId: r.userId, sessionId: r.sessionId ?? null, principalKind: 'user' }
        : null;
    }

    // Service-account token — a non-human IAM principal (synthetic id).
    if (isServiceAccountToken(token)) {
      const r = await validateServiceAccountToken(token);
      if (!r.isValid || !r.serviceAccountId) return null;
      bindAuditPrincipal(
        previewActorFields({
          kind: 'service_account',
          principalId: r.serviceAccountId,
          sandboxAuthored: false,
          method: 'service_account',
        }),
      );
      return (await canAccessPreviewSandbox({ previewSandboxId: sandboxId, userId: r.serviceAccountId }))
        ? { userId: r.serviceAccountId, sessionId: null, principalKind: 'service_account' }
        : null;
    }

    // Kortix API / sandbox token — ownership is checked against the account.
    if (isKortixToken(token)) {
      const r = await validateSecretKey(token);
      if (!r.isValid || !r.accountId) return null;
      bindAuditPrincipal(
        previewActorFields({
          kind: 'account',
          principalId: r.accountId,
          // A sandbox key is the sandbox itself calling its own preview.
          sandboxAuthored: r.type === 'sandbox',
          method: r.type === 'sandbox' ? 'sandbox_token' : 'api_key',
        }),
      );
      return (await canAccessPreviewSandbox({ previewSandboxId: sandboxId, accountId: r.accountId }))
        ? { userId: r.accountId, sessionId: null, principalKind: 'account' }
        : null;
    }

    // Supabase JWT — fast local verify, network fallback when the local
    // verifier cannot reach a verdict. Route on the SAME predicate as both auth
    // middlewares: a hand-listed reason set here once omitted
    // `unsupported-alg:HS256`, so every preview origin answered "Sign in" to a
    // valid legacy-signed session while `/v1/p/...` served it.
    const local = await verifySupabaseJwt(token);
    if (local.ok) {
      bindAuditPrincipal(
        previewActorFields({ kind: 'user', principalId: local.userId, sandboxAuthored: false, method: 'jwt' }),
      );
      return (await canAccessPreviewSandbox({ previewSandboxId: sandboxId, userId: local.userId }))
        ? { userId: local.userId, sessionId: null, principalKind: 'user' }
        : null;
    }
    if (!isInconclusiveVerifyFailure(local.reason)) return null;

    const supabase = getSupabase();
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return null;
    bindAuditPrincipal(
      previewActorFields({ kind: 'user', principalId: user.id, sandboxAuthored: false, method: 'jwt' }),
    );
    return (await canAccessPreviewSandbox({ previewSandboxId: sandboxId, userId: user.id }))
      ? { userId: user.id, sessionId: null, principalKind: 'user' }
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
