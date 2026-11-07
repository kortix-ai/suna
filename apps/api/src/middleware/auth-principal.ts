import { Context } from 'hono';
import { setSentryUser } from '../lib/sentry';
import { setContextField } from '../lib/request-context';
import { HTTPException } from 'hono/http-exception';
import { auditLoginFail, auditLoginSuccess } from './auth-audit';
import { keyScopeMethodAllows } from '../iam/key-scope';
import { jitSyncSso } from './auth-sso';
import { setPreviewSessionCookie } from './auth-scope';

type Preview = { token: string; enabled: boolean };

/** The code a read-only key's write request is refused with. */
export const KEY_SCOPE_READ_ONLY_CODE = 'key_scope_read_only';

function keyScopeReadOnly403(method: string): HTTPException {
  const message = `This key is read-only and cannot make a ${method.toUpperCase()} request. Use a key with write permissions.`;
  return new HTTPException(403, {
    message,
    res: new Response(JSON.stringify({ error: true, message, status: 403, code: KEY_SCOPE_READ_ONLY_CODE }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    }),
  });
}

export function serviceAccountPrincipal(c: Context, id: string, accountId: string, preview?: Preview) {
  c.set('userId', id);
  c.set('userEmail', '');
  c.set('authType', 'service_account');
  c.set('accountId', accountId);
  c.set('iamTokenId', id);
  setSentryUser({ id, accountId });
  setContextField('userId', id);
  setContextField('accountId', accountId);
  if (preview?.enabled) setPreviewSessionCookie(c, preview.token);
  auditLoginSuccess({ c, userId: id, accountId, authType: 'service_account' });
}

export function patPrincipal(c: Context, result: Awaited<ReturnType<typeof import('../repositories/account-tokens').validateAccountToken>>, preview?: Preview) {
  // A read-only workspace key (`scopes` holds only `*.read` actions) makes no
  // write request at all, whatever the route gates on (iam/key-scope.ts).
  if (!keyScopeMethodAllows(result.scopes ?? null, c.req.method)) {
    auditLoginFail({ c, reason: 'key_scope_read_only', authType: 'pat', accountId: result.accountId ?? null });
    throw keyScopeReadOnly403(c.req.method);
  }
  const userId = result.userId!;
  c.set('userId', userId);
  c.set('userEmail', '');
  // A workspace key that acts as an agent or a bot (`service_account_id` set,
  // no session, design.md §3.2 C4b): `user_id` is that service account, and
  // the request is a service account's in every gate that asks, while the
  // token row keeps its workspace binding and scope (`iamTokenId` below).
  c.set('authType', result.serviceAccountId && !result.sessionId ? 'service_account' : 'pat');
  if (result.accountId) c.set('accountId', result.accountId);
  if (result.projectId) c.set('tokenProjectId', result.projectId);
  if (preview || result.tokenId) c.set('iamTokenId', result.tokenId);
  if (result.sessionId) {
    c.set('sessionId', result.sessionId);
    c.set('sandboxId', result.sessionId);
  }
  c.set('agentGrant', result.agentGrant ?? null);
  c.set('onBehalfOfUserId', result.onBehalfOfUserId ?? null);
  // The token's IAM binding, from the row validation just read: `buildActor`
  // uses it instead of reading the same `account_tokens` row again. Only a
  // result that actually carries the row's `service_account_id` qualifies (a
  // stubbed or partial result does not): seeding a missing service account
  // would demote an agent-session token to a plain PAT, so anything less
  // falls back to the read.
  if (result.tokenId && result.serviceAccountId !== undefined) {
    c.set('iamTokenBinding', {
      tokenId: result.tokenId,
      projectId: result.projectId ?? null,
      agentGrant: result.agentGrant ?? null,
      serviceAccountId: result.serviceAccountId,
      sessionId: result.sessionId ?? null,
      onBehalfOfUserId: result.onBehalfOfUserId ?? null,
      scopes: result.scopes ?? null,
    });
  }
  setSentryUser({ id: userId, accountId: result.accountId });
  setContextField('userId', userId);
  if (result.accountId) setContextField('accountId', result.accountId);
  if (preview?.enabled) setPreviewSessionCookie(c, preview.token);
  auditLoginSuccess({ c, userId, accountId: result.accountId ?? null, authType: c.get('authType') === 'service_account' ? 'service_account' : 'pat',
    metadata: preview ? undefined : result.projectId ? { project_id: result.projectId } : undefined });
}

export async function jwtPrincipal(c: Context, userId: string, email: string, payload: Record<string, unknown> | undefined, path: 'local' | 'network', preview?: Preview, sentryEmail?: string) {
  c.set('userId', userId);
  c.set('userEmail', email);
  c.set('authType', 'supabase');
  // The token's assurance level ('aal2' = the session passed MFA), on every
  // path: MFA gates read it (`mfaGateBlocks`, the IAM actor). combinedAuth's
  // local path used to drop it, so an account that requires MFA refused an
  // aal2 session there (2026-10-01: chat `/bind` asked for the code again
  // after every step-up).
  if (payload?.aal) c.set('mfaAal', payload.aal);
  if (!preview || path === 'network') {
    if (payload?.session_id) c.set('sessionId', payload.session_id);
    if (typeof payload?.iat === 'number') c.set('sessionIat', payload.iat);
  }
  if (!preview && path === 'local') await jitSyncSso(userId, email, payload);
  setSentryUser({ id: userId, email: sentryEmail ?? email });
  setContextField('userId', userId);
  setContextField('userEmail', email);
  if (preview?.enabled) setPreviewSessionCookie(c, preview.token);
  auditLoginSuccess({ c, userId, authType: 'supabase', metadata: !preview && path === 'local'
    ? { aal: payload?.aal ?? null, verify_path: path } : { verify_path: path } });
  if (preview || path === 'network') await jitSyncSso(userId, email, payload);
}
