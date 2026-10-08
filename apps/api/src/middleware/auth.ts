import { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { validateSecretKey } from '../repositories/api-keys';
import { validateAccountToken } from '../repositories/account-tokens';
import { validateServiceAccountToken } from '../repositories/service-accounts';
import { isKortixToken, isAccountToken, isServiceAccountToken } from '../shared/crypto';
import { getSupabase } from '../shared/supabase';
import { decodeSupabaseJwtPayload, verifySupabaseJwt } from '../shared/jwt-verify';
// From its own module, not '../shared/jwt-verify': five test files replace that
// module wholesale, and a mock cannot be allowed to change how a real failure is
// classified.
import { isInconclusiveVerifyFailure } from '../shared/jwt-verify-outcome';
import { setSentryUser } from '../lib/sentry';
import { setContextField } from '../lib/request-context';
import { auditLoginFail, auditLoginSuccess } from './auth-audit';
import { markDeadCredential } from '../shared/dead-credential-log';
import { requestClientKey } from './client-ip';
import { isOAuthAccessToken } from '../oauth/access-token';
import { applyImpersonation } from './impersonation';
import { withActor } from './auth-actor';
import { beginStage } from '../lib/server-timing';
import { presentedKortixToken, withTokenAttemptBudget } from './token-attempt-budget';

import { serviceAccountPrincipal, patPrincipal, jwtPrincipal } from './auth-principal';
import { applyOAuthAccessTokenPrincipal } from './auth-oauth';
import { enforceTokenProjectScope } from './auth-scope';
import { bearerToken } from '../shared/bearer-token';
export { clearSsoSyncMemo } from './auth-sso';
export { combinedAuth } from './auth-combined';

/**
 * Stable error code the PAT auth gate returns (HTTP 401) when the credential
 * itself can never come back: missing, revoked, expired, or its sandbox lease
 * closed. The body keeps the global `{error, message, status}` shape and adds
 * this `code`, so a retrying client can branch on it and stop instead of
 * hammering the gate forever — prod 2026-09-26/27: one fleet of boxes that
 * outlived their session credential produced ~10k 401s/h across
 * `/v1/platform/runtime-projection`, `/turn-stream` and `/audit/events`, every
 * one a plain untyped 401 no client could tell apart from a transient one.
 * Mirrors the typed-error pattern of `buildDenialError` (`code:'account_mfa_required'`)
 * and `impersonation.ts` (`code:'impersonation_invalid'`): an HTTPException
 * built with an explicit `res` is returned verbatim by the global error
 * handler (apps/api/src/index.ts), so the body arrives untyped nowhere.
 * Consumers: apps/kortix-sandbox-agent-server's `session-token-health.ts`
 * breaker classifies the body; the SDK's ApiError lifts `code` from error
 * bodies. Keep the string in sync with that breaker.
 */
export const SESSION_TOKEN_REVOKED_CODE = 'session_token_revoked';

export function deadCredential401(message: string): HTTPException {
  const err = new HTTPException(401, {
    message,
    res: new Response(
      JSON.stringify({ error: true, message, status: 401, code: SESSION_TOKEN_REVOKED_CODE }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    ),
  });
  // The body above already tells a reading client to stop. One that does not
  // (an in-sandbox agent CLI retrying per step) would otherwise put one warn
  // line per refusal into the API log — the KRTX-1039 spike. The mark routes
  // this exception through the global error handler's log throttle without
  // touching the response.
  markDeadCredential(err);
  return err;
}



/**
 * API key auth for search, LLM, and router routes.
 * Always validates Kortix tokens (kortix_, kortix_sb_) via validateSecretKey()
 * against the api_keys table.
 */
export async function apiKeyAuth(c: Context, next: Next) {
  const endAuth = beginStage('auth');
  try {
    await withTokenAttemptBudget(c, presentedKortixToken(c), () =>
      resolveApiKeyAuth(c, () => withActor(c, () => (endAuth(), next()))),
    );
  } finally {
    endAuth();
  }
}

async function resolveApiKeyAuth(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');

  const token = bearerToken(authHeader);
  if (token === null) {
    auditLoginFail({ c, reason: 'missing_auth_header', authType: 'apiKey' });
    throw new HTTPException(401, {
      message: 'Missing or invalid Authorization header',
    });
  }

  if (!token) {
    auditLoginFail({ c, reason: 'empty_token', authType: 'apiKey' });
    throw new HTTPException(401, {
      message: 'Missing token in Authorization header',
    });
  }

  if (!isKortixToken(token)) {
    auditLoginFail({ c, reason: 'bad_token_format', authType: 'apiKey' });
    throw new HTTPException(401, {
      message: 'Invalid token format — expected kortix_ prefix',
    });
  }

  const result = await validateSecretKey(token);

  if (!result.isValid) {
    console.warn(
      `[apiKeyAuth] Token validation failed: ${result.error} | tokenPrefix="${token.slice(0, 20)}..." | path=${c.req.path} | ip=${requestClientKey(c)}`,
    );
    auditLoginFail({
      c,
      reason: result.error ?? 'invalid_api_key',
      authType: 'apiKey',
    });
    throw new HTTPException(401, {
      message: result.error || 'Invalid API key',
    });
  }

  c.set('accountId', result.accountId);
  c.set('keyId', result.keyId);
  c.set('authType', 'apiKey');
  c.set('apiKeyType', result.type);
  if (result.sandboxId) {
    c.set('sandboxId', result.sandboxId);
  }
  auditLoginSuccess({
    c,
    userId: result.accountId ?? 'unknown',
    accountId: result.accountId,
    authType: 'apiKey',
    metadata: { api_key_type: result.type },
  });
  await next();
}

/**
 * Supabase JWT auth (for billing, platform, admin routes).
 * Header-only — sets userId and userEmail in context on success.
 *
 * Also accepts CLI Personal Access Tokens (kortix_pat_...) — these carry
 * a real user_id from the account_tokens table, so the rest of the
 * pipeline (resolveAccountId, project access checks, etc.) works
 * unchanged.
 *
 * Selected runtime routes accept a session-scoped KORTIX_TOKEN. They never
 * return an upstream provider credential.
 */
export async function supabaseAuth(c: Context, next: Next) {
  // `Server-Timing: auth` spans credential verification, impersonation and the
  // IAM actor build — everything before the handler — and closes the moment
  // the handler starts (or the chain throws a 401/403).
  const endAuth = beginStage('auth');
  try {
    return await withTokenAttemptBudget(c, presentedKortixToken(c), () =>
      resolveSupabaseAuth(c, () =>
        applyImpersonation(c, () => withActor(c, () => (endAuth(), next()))),
      ),
    );
  } finally {
    endAuth();
  }
}

async function resolveSupabaseAuth(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');

  const token = bearerToken(authHeader);
  if (token === null) {
    auditLoginFail({ c, reason: 'missing_auth_header' });
    throw new HTTPException(401, { message: 'Missing or invalid Authorization header' });
  }

  if (!token) {
    auditLoginFail({ c, reason: 'empty_token' });
    throw new HTTPException(401, { message: 'Missing token' });
  }

  if (isServiceAccountToken(token)) return resolveServiceAccount(c, next, token);
  if (isAccountToken(token)) return resolvePat(c, next, token);
  if (isOAuthAccessToken(token)) {
    await applyOAuthAccessTokenPrincipal(c, token);
    return next();
  }
  if (isKortixToken(token) && sandboxTokenPathAllowed(c.req.path)) return resolveSandboxToken(c, next, token);
  return resolveJwt(c, next, token);
}

async function resolveServiceAccount(c: Context, next: Next, token: string) {
  // Service-account bearer (non-human IAM principal). Treat as a
  // token-style principal: userId is set to the SA id (synthetic) so
  // downstream code has a stable identifier, and iamTokenId points
  // at the same id so the IAM engine evaluates only the SA's policies
  // (existing token-as-principal short-circuit).
  {
    const sa = await validateServiceAccountToken(token);
    if (!sa.isValid || !sa.serviceAccountId || !sa.accountId) {
      auditLoginFail({
        c,
        reason: sa.error ?? 'invalid_service_account',
        authType: 'service_account',
      });
      throw new HTTPException(401, { message: sa.error || 'Invalid service account' });
    }
    serviceAccountPrincipal(c, sa.serviceAccountId, sa.accountId);
    await next();
    return;
  }

}

async function resolvePat(c: Context, next: Next, token: string) {
  // CLI Personal Access Token — same identity as the user who minted it.
  {
    const result = await validateAccountToken(token);
    if (!result.isValid || !result.userId) {
      auditLoginFail({ c, reason: result.error ?? 'invalid_pat', authType: 'pat' });
      // A credential that can never come back gets the typed 401 so the
      // caller's retry loop can stop; every other refusal keeps the plain 401.
      if (result.credentialDead) {
        throw deadCredential401(result.error || 'Credential is no longer valid');
      }
      throw new HTTPException(401, { message: result.error || 'Invalid PAT' });
    }
    if (result.projectId) {
      await enforceTokenProjectScope(c, result.projectId, {
        sessionBound: Boolean(result.sessionId),
      });
    }
    patPrincipal(c, result);
    await next();
    return;
  }

}

function sandboxTokenPathAllowed(path: string) {
  return (
    path.endsWith('/turn-stream') ||
    path.endsWith('/turn-question') ||
    // The daemon relays OpenCode `permission.asked` so apps/api can push the
    // session creator. The handler re-checks sandbox, project, and session.
    /^\/v1\/projects\/[^/]+\/turn-permission$/.test(path) ||
    // The seed daemon fetches the org model catalog at PARK with its sandbox
    // token (no per-session LLM key yet) so the no-restart warm-fork bakes the
    // full picker. Catalog is the non-secret model list — safe for a sandbox token.
    path.endsWith('/llm-catalog') ||
    // The daemon relays its own in-guest boot timeline here at runtime-ready, so
    // the ~11-15s of in-guest boot latency becomes queryable alongside the host
    // marks in provider_events instead of dying with the sandbox. Write-only
    // telemetry about the caller's OWN boot, and the handler re-checks that the
    // token's sandboxId matches the session it claims to be reporting for.
    path.endsWith('/boot-timeline') ||
    // The runtime relay sends redacted OpenCode lifecycle events for its own
    // session. The handler re-checks sandbox, account, project, and session.
    path.endsWith('/audit/events') ||
    // The monitor runner POSTs its own box's stdout lines here. The handler
    // re-checks the token against `project_monitor_boxes` (sandbox id ∧
    // project ∧ account ∧ live status) — a monitor box has no
    // `session_sandboxes` row, so it authenticates against that table only.
    path.endsWith('/monitors/ingest') ||
    // The daemon pushes its OWN session's runtime projection (the
    // `/kortix/opencode/state` document) so the control plane can serve it
    // without a sandbox hop. Write-only, about the caller's own session, and
    // the handler re-checks the token's sandbox against `session_sandboxes`
    // (sandbox id -> session -> account) before it stores anything.
    path.endsWith('/runtime-projection') ||
    // A legacy sandbox credential can fetch one descriptor for one persisted
    // prompt attachment. The route handler re-checks sandbox, session,
    // account, project, command, reference, and part index. Keep this exact
    // shape: a broader attachment prefix would expose user upload routes.
    /^\/v1\/projects\/[^/]+\/runtime\/prompt-attachments\/[^/]+$/.test(path));
}

async function resolveSandboxToken(c: Context, next: Next, token: string) {
  {
    const result = await validateSecretKey(token);
    if (!result.isValid) {
      throw new HTTPException(401, { message: result.error || 'Invalid Kortix token' });
    }
    if (result.type !== 'sandbox' || !result.sandboxId) {
      throw new HTTPException(403, { message: 'This route requires a sandbox token' });
    }
    c.set('userId', result.accountId || '');
    c.set('userEmail', '');
    c.set('authType', 'apiKey');
    c.set('apiKeyType', result.type);
    if (result.accountId) c.set('accountId', result.accountId);
    if (result.keyId) c.set('keyId', result.keyId);
    c.set('sandboxId', result.sandboxId);
    setSentryUser({ id: result.accountId || 'unknown', accountId: result.accountId });
    setContextField('accountId', result.accountId || 'unknown');
    await next();
    return;
  }

}

async function resolveJwt(c: Context, next: Next, token: string) {
  // Fast path: verify JWT locally (no network roundtrip)
  const local = await verifySupabaseJwt(token);
  if (local.ok) {
    await jwtPrincipal(c, local.userId, local.email, local.payload as Record<string, unknown>, 'local');
    await next();
    return;
  }

  // Local verification reached no verdict (JWKS not loaded, unknown kid, or an
  // algorithm this verifier does not implement) — fall back to the network.
  if (!isInconclusiveVerifyFailure(local.reason)) {
    // Token is definitively invalid (bad signature, expired, malformed)
    auditLoginFail({ c, reason: `jwt_${local.reason}`, authType: 'jwt' });
    throw new HTTPException(401, { message: 'Invalid or expired token' });
  }

  try {
    const supabase = getSupabase();
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);

    if (error || !user) {
      auditLoginFail({
        c,
        reason: error?.message ?? 'jwt_network_invalid',
        authType: 'jwt',
      });
      throw new HTTPException(401, { message: 'Invalid or expired token' });
    }

    const payload = decodeSupabaseJwtPayload(token);
    await jwtPrincipal(c, user.id, user.email || '', (payload as Record<string, unknown> | null) ?? (user as unknown as Record<string, unknown>), 'network', undefined, user.email || undefined);
    await next();
  } catch (err) {
    if (err instanceof HTTPException) throw err;
    console.error('Auth error:', err);
    auditLoginFail({ c, reason: 'auth_internal_error', authType: 'jwt' });
    throw new HTTPException(401, { message: 'Authentication failed' });
  }
}
