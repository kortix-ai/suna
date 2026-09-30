// OpenCode Console account login ("Sign in with OpenCode") for OpenCode Zen
// (`opencode`) and OpenCode Go (`opencode-go`). The same device grant the
// OpenCode CLI runs (`opencode auth login opencode`, anomalyco/opencode
// packages/core/src/plugin/provider/opencode.ts), measured live 2026-09-30:
//
//   1. POST /auth/device/code {client_id} → {device_code, user_code,
//      verification_uri_complete (relative), expires_in: 600, interval: 5}
//   2. poll POST /auth/device/token {grant_type: device_code, device_code,
//      client_id} → 400 {error: authorization_pending} | 200 {access_token,
//      refresh_token, expires_in (30 days)}
//   3. GET /api/orgs (bearer) → the workspaces; the first by name is used.
//   Refresh: POST /auth/device/token {grant_type: refresh_token}; a dead
//   token answers 400 invalid_grant. The refresh token rotates on use.
//
// The login is stored as the provider's own key secret (OPENCODE_GO_API_KEY,
// OPENCODE_API_KEY) in place of an API key, so sharing, pooling, grants, the
// picker, and disconnect treat both forms as one credential. The access token
// is refused on the API-key endpoints (`/zen/go/v1` → 401) and accepted on
// `https://opencode.ai/inference/...` with the workspace in x-opencode-org-id.

import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { accountSecretResources, projectSecrets } from '@kortix/db';
import type { ProviderKind } from '@kortix/llm-gateway';
import { db } from '../../shared/db';
import { decryptProjectSecret, encryptProjectSecret } from '../../projects/secrets/envelope';
import { decryptAccountSecret, encryptAccountSecret } from '../../secrets/account-resource';
import { recordAuditEvent } from '../../shared/audit';
import { isPermanentRefreshRejection, refreshErrorCode } from './codex-core';

const CONSOLE = 'https://opencode.ai/console';
const CLIENT_ID = 'opencode-cli';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
// Tokens live 30 days; refresh a day early so a rotation race has room.
const REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Providers a Console login serves, and the inference path prefix of each. */
export const OPENCODE_CONSOLE_PROVIDERS: Record<string, string> = {
  opencode: 'https://opencode.ai/inference',
  'opencode-go': 'https://opencode.ai/inference/go',
};

export interface OpencodeLogin {
  type: 'oauth';
  access: string;
  refresh: string;
  expires: number;
  orgId?: string;
  orgName?: string;
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;
const defaultFetch: FetchImpl = (input, init) => fetch(input, init);

async function post(fetchImpl: FetchImpl, path: string, body: Record<string, string>) {
  return fetchImpl(`${CONSOLE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function startOpencodeDeviceAuth(fetchImpl: FetchImpl = defaultFetch) {
  const res = await post(fetchImpl, '/auth/device/code', { client_id: CLIENT_ID });
  if (!res.ok) throw new Error(`Failed to start OpenCode authorization (${res.status})`);
  const data = await res.json() as { device_code?: string; user_code?: string; verification_uri_complete?: string; interval?: number };
  if (!data.device_code || !data.user_code || !data.verification_uri_complete) {
    throw new Error('OpenCode did not return a device code');
  }
  const url = new URL(data.verification_uri_complete, `${CONSOLE}/`);
  if (url.protocol !== 'https:') throw new Error('OpenCode returned an invalid verification URL');
  return {
    verificationUrl: url.href,
    userCode: data.user_code,
    deviceCode: data.device_code,
    intervalMs: Math.max(Number(data.interval) || 5, 1) * 1000,
  };
}

export async function pollOpencodeDeviceAuth(
  deviceCode: string, fetchImpl: FetchImpl = defaultFetch,
): Promise<{ status: 'pending' } | { status: 'failed'; error: string } | { status: 'authorized'; authJson: string }> {
  const res = await post(fetchImpl, '/auth/device/token', { grant_type: DEVICE_GRANT, device_code: deviceCode, client_id: CLIENT_ID });
  const body = await res.json().catch(() => null) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string } | null;
  if (body?.error === 'authorization_pending' || body?.error === 'slow_down') return { status: 'pending' };
  if (!res.ok || !body?.access_token || !body.refresh_token) {
    return { status: 'failed', error: `OpenCode authorization failed (${body?.error ?? res.status})` };
  }
  const orgs = await fetchImpl(`${CONSOLE}/api/orgs`, {
    headers: { Authorization: `Bearer ${body.access_token}`, Accept: 'application/json' },
  }).then((r) => (r.ok ? r.json() : [])).catch(() => []) as Array<{ id?: string; name?: string }>;
  const org = [...orgs].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '') || (a.id ?? '').localeCompare(b.id ?? ''))[0];
  const login: OpencodeLogin = {
    type: 'oauth',
    access: body.access_token,
    refresh: body.refresh_token,
    expires: Date.now() + (body.expires_in ?? 30 * 86400) * 1000,
    ...(org?.id ? { orgId: org.id } : {}),
    ...(org?.name ? { orgName: org.name } : {}),
  };
  return { status: 'authorized', authJson: JSON.stringify(login) };
}

/** A stored Console login, or null for a plain API key. */
export function parseOpencodeLogin(value: string): OpencodeLogin | null {
  if (!value.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(value) as Partial<OpencodeLogin>;
    return parsed.type === 'oauth' && typeof parsed.access === 'string' && typeof parsed.refresh === 'string'
      ? parsed as OpencodeLogin : null;
  } catch {
    return null;
  }
}

/** The inference base a Console token is accepted on, for the model's wire format. */
export function opencodeInferenceBaseUrl(providerId: string, kind: ProviderKind, npm?: string): string | null {
  const prefix = OPENCODE_CONSOLE_PROVIDERS[providerId];
  if (!prefix) return null;
  if (kind === 'anthropic') return `${prefix}/anthropic/v1`;
  if (npm === '@ai-sdk/google') return `${prefix}/google/v1beta`;
  return `${prefix}/openai/v1`;
}

export interface OpencodeLoginRow {
  storage: 'project' | 'account_resource';
  accountId: string;
  projectId: string;
  secretId: string;
  value: string;
  sessionId?: string | null;
  actorUserId: string;
}

const inflight = new Map<string, Promise<OpencodeLogin>>();

async function refreshAndPersist(row: OpencodeLoginRow, current: OpencodeLogin, fetchImpl: FetchImpl): Promise<OpencodeLogin> {
  const res = await post(fetchImpl, '/auth/device/token', { grant_type: 'refresh_token', refresh_token: current.refresh, client_id: CLIENT_ID });
  const body = await res.json().catch(() => null) as { access_token?: string; refresh_token?: string; expires_in?: number } | null;
  const code = refreshErrorCode(body);
  const permanent = !res.ok && isPermanentRefreshRejection(res.status, code);
  if (!res.ok || !body?.access_token) {
    if (permanent && row.storage === 'account_resource') {
      await db.update(accountSecretResources)
        .set({ needsReauthAt: sql`coalesce(${accountSecretResources.needsReauthAt}, now())` })
        .where(and(eq(accountSecretResources.accountId, row.accountId), eq(accountSecretResources.secretId, row.secretId)))
        .catch(() => undefined);
    }
    await recordRefreshAudit(row, 'failure', res.status, code);
    throw new Error(`OpenCode login refresh failed (${code ?? res.status})`);
  }
  const next: OpencodeLogin = {
    ...current,
    access: body.access_token,
    refresh: body.refresh_token ?? current.refresh,
    expires: Date.now() + (body.expires_in ?? 30 * 86400) * 1000,
  };
  const value = JSON.stringify(next);
  // Unconditional: the refresh token rotated, so this is now the only login that works.
  if (row.storage === 'account_resource') {
    await db.update(accountSecretResources)
      .set({ valueEnc: encryptAccountSecret(row.accountId, value), updatedAt: new Date(), needsReauthAt: null })
      .where(and(eq(accountSecretResources.accountId, row.accountId), eq(accountSecretResources.secretId, row.secretId)));
  } else {
    await db.update(projectSecrets)
      .set({ valueEnc: encryptProjectSecret(row.projectId, value), updatedAt: new Date() })
      .where(eq(projectSecrets.secretId, row.secretId));
  }
  await recordRefreshAudit(row, 'success', res.status);
  return next;
}

async function recordRefreshAudit(row: OpencodeLoginRow, outcome: 'success' | 'failure', status: number, code?: string) {
  await recordAuditEvent({
    accountId: row.accountId,
    projectId: row.projectId,
    sessionId: row.sessionId ?? null,
    actorUserId: row.actorUserId,
    actorType: row.sessionId ? 'agent' : 'human',
    source: 'llm_gateway',
    ...(outcome === 'failure' ? { outcome: 'failure' as const } : {}),
    action: outcome === 'success' ? 'secret.consumer.refreshed' : 'secret.consumer.refresh_failed',
    resourceType: row.storage === 'account_resource' ? 'account_secret_resource' : 'project_secret',
    resourceId: row.secretId,
    metadata: { consumer: 'llm_gateway', login: 'opencode_console', upstream_status: status, ...(code ? { error_code: code } : {}) },
  });
}

function refreshOnce(row: OpencodeLoginRow, current: OpencodeLogin, fetchImpl: FetchImpl) {
  const pending = inflight.get(row.secretId) ?? refreshAndPersist(row, current, fetchImpl)
    .finally(() => inflight.delete(row.secretId));
  inflight.set(row.secretId, pending);
  return pending;
}

/**
 * The login to send now: refreshed when it expires within a day. A failed
 * refresh keeps serving a token that has not expired yet.
 */
export async function resolveOpencodeLogin(row: OpencodeLoginRow, fetchImpl: FetchImpl = defaultFetch): Promise<OpencodeLogin | null> {
  const login = parseOpencodeLogin(row.value);
  if (!login) return null;
  if (login.expires - Date.now() > REFRESH_WINDOW_MS) return login;
  try {
    return await refreshOnce(row, login, fetchImpl);
  } catch (err) {
    if (login.expires > Date.now()) return login;
    throw err;
  }
}

/**
 * After the provider refused `failedKeySha256` (401): the stored login when
 * another request already replaced it, else one forced refresh. Null when the
 * row is not a Console login or the refresh fails.
 */
export async function refreshRefusedOpencodeLogin(
  input: { accountId: string; projectId: string; secretId: string; userId: string; sessionId: string | null; failedKeySha256: string },
  fetchImpl: FetchImpl = defaultFetch,
): Promise<OpencodeLogin | null> {
  const row = await loadOpencodeLoginRow(input);
  const login = row && parseOpencodeLogin(row.value);
  if (!row || !login) return null;
  if (sha256(login.access) !== input.failedKeySha256) return login;
  return refreshOnce(row, login, fetchImpl).catch(() => null);
}

async function loadOpencodeLoginRow(input: { accountId: string; projectId: string; secretId: string; userId: string; sessionId: string | null }): Promise<OpencodeLoginRow | null> {
  const base = { accountId: input.accountId, projectId: input.projectId, secretId: input.secretId, actorUserId: input.userId, sessionId: input.sessionId };
  const [resource] = await db.select({ valueEnc: accountSecretResources.valueEnc, providerId: accountSecretResources.providerId, needsReauthAt: accountSecretResources.needsReauthAt })
    .from(accountSecretResources)
    .where(and(eq(accountSecretResources.accountId, input.accountId), eq(accountSecretResources.secretId, input.secretId))).limit(1);
  if (resource) {
    if (!resource.providerId || !OPENCODE_CONSOLE_PROVIDERS[resource.providerId] || resource.needsReauthAt) return null;
    try {
      return { ...base, storage: 'account_resource', value: decryptAccountSecret(input.accountId, resource.valueEnc) };
    } catch {
      return null;
    }
  }
  const [secret] = await db.select({ valueEnc: projectSecrets.valueEnc })
    .from(projectSecrets)
    .where(and(eq(projectSecrets.projectId, input.projectId), eq(projectSecrets.secretId, input.secretId))).limit(1);
  if (!secret) return null;
  try {
    return { ...base, storage: 'project', value: decryptProjectSecret(input.projectId, secret.valueEnc) };
  } catch {
    return null;
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
