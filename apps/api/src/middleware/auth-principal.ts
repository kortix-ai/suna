import { Context } from 'hono';
import { setSentryUser } from '../lib/sentry';
import { setContextField } from '../lib/request-context';
import { auditLoginSuccess } from '../shared/auth-audit';
import { jitSyncSso } from './auth-sso';
import { setPreviewSessionCookie } from './auth-scope';

type Preview = { token: string; enabled: boolean };

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
  const userId = result.userId!;
  c.set('userId', userId);
  c.set('userEmail', '');
  c.set('authType', 'pat');
  if (result.accountId) c.set('accountId', result.accountId);
  if (result.projectId) c.set('tokenProjectId', result.projectId);
  if (preview || result.tokenId) c.set('iamTokenId', result.tokenId);
  if (result.sessionId) {
    c.set('sessionId', result.sessionId);
    c.set('sandboxId', result.sessionId);
  }
  c.set('agentGrant', result.agentGrant ?? null);
  c.set('onBehalfOfUserId', result.onBehalfOfUserId ?? null);
  setSentryUser({ id: userId, accountId: result.accountId });
  setContextField('userId', userId);
  if (result.accountId) setContextField('accountId', result.accountId);
  if (preview?.enabled) setPreviewSessionCookie(c, preview.token);
  auditLoginSuccess({ c, userId, accountId: result.accountId ?? null, authType: 'pat',
    metadata: preview ? undefined : result.projectId ? { project_id: result.projectId } : undefined });
}

export async function jwtPrincipal(c: Context, userId: string, email: string, payload: Record<string, unknown> | undefined, path: 'local' | 'network', preview?: Preview, sentryEmail?: string) {
  c.set('userId', userId);
  c.set('userEmail', email);
  c.set('authType', 'supabase');
  if (!preview || path === 'network') {
    if (payload?.aal) c.set('mfaAal', payload.aal);
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
