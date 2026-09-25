import { and, eq, sql } from 'drizzle-orm';
import { accountSecretResources, projectSecrets } from '@kortix/db';
import { db } from '../../shared/db';
import {
  encryptProjectSecret,
  resolveProjectSecretForConsumer,
} from '../../projects/secrets';
import { recordAuditEvent } from '../../shared/audit';
import { encryptAccountSecret } from '../../secrets/account-resource';
import {
  CodexRefreshError,
  OPENAI_AUTH_BASE,
  applyRefresh,
  buildRefreshBody,
  isPermanentRefreshRejection,
  needsRefresh,
  parseCodexAuth,
  refreshErrorCode,
  tokenStillValid,
  type CodexCredential,
  type StoredCodexAuth,
} from './codex-core';

export { CHATGPT_CODEX_BASE_URL, CODEX_USER_AGENT, CodexRefreshError } from './codex-core';
export type { CodexCredential } from './codex-core';

const CODEX_AUTH_JSON_SECRET_NAME = 'CODEX_AUTH_JSON';

type FetchImpl = (input: string, init: RequestInit) => Promise<Response>;

interface SecretRow {
  storage: 'project' | 'account_resource';
  accountId: string;
  secretId: string;
  ownerUserId: string | null;
  /** Null when the stored login cannot be decrypted. */
  value: string | null;
  actorUserId: string;
  sessionId: string | null;
  /** The account row's `updated_at` when it was read; guards the reconnection mark. */
  loadedUpdatedAt?: Date;
}

/**
 * Record that an account's stored login stopped working, across gateway
 * replicas. Keeps the first failure time and never moves `updated_at`, so a
 * concurrent successful refresh or reconnect still wins. Skipped when the row
 * changed after it was read: another replica refreshed it, or its owner
 * reconnected it. Timestamps compare at millisecond precision, the precision a
 * JavaScript `Date` read of the row carries. Best effort: the request already
 * failed, and a failed mark must not change why.
 */
async function markNeedsReauth(row: SecretRow): Promise<void> {
  if (row.storage !== 'account_resource' || !row.loadedUpdatedAt) return;
  try {
    await db.update(accountSecretResources).set({
      needsReauthAt: sql`coalesce(${accountSecretResources.needsReauthAt}, now())`,
    }).where(and(
      eq(accountSecretResources.accountId, row.accountId),
      eq(accountSecretResources.secretId, row.secretId),
      sql`date_trunc('milliseconds', ${accountSecretResources.updatedAt}) = ${row.loadedUpdatedAt.toISOString()}::timestamptz`,
    ));
  } catch (err) {
    console.warn(`[codex] could not mark account secret ${row.secretId} for reconnection: ${err instanceof Error ? err.message : String(err)}`);
  }
}

interface CodexCredentialContext {
  accountId?: string;
  sessionId?: string | null;
  /** Whose personal CODEX_AUTH_JSON override applies (spec 2026-09-22 §2.3).
   *  Absent = `userId` (legacy); null = the shared row only. */
  principalUserId?: string | null;
}

async function loadCodexRow(
  projectId: string,
  userId: string,
  context: CodexCredentialContext,
): Promise<SecretRow | null> {
  const resolved = await resolveProjectSecretForConsumer({
    projectId,
    accountId: context.accountId,
    sessionId: context.sessionId,
    actorUserId: userId,
    principalUserId: context.principalUserId === undefined ? userId : context.principalUserId,
    name: CODEX_AUTH_JSON_SECRET_NAME,
    consumer: 'llm_gateway',
  });
  return resolved
    ? {
        ...resolved,
        storage: 'project',
        actorUserId: userId,
        sessionId: context.sessionId ?? null,
      }
    : null;
}

const inflightRefresh = new Map<string, Promise<StoredCodexAuth | null>>();

async function refreshAndPersist(
  projectId: string,
  row: SecretRow,
  current: StoredCodexAuth,
  fetchImpl: FetchImpl,
): Promise<StoredCodexAuth | null> {
  if (!current.refresh) return null;

  let upstreamStatus: number | undefined;
  try {
    const response = await fetchImpl(`${OPENAI_AUTH_BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: buildRefreshBody(current.refresh),
    });
    upstreamStatus = response.status;
    if (!response.ok) {
      const code = refreshErrorCode(await response.json().catch(() => null));
      throw new CodexRefreshError('upstream rejected refresh', response.status, {
        code,
        permanent: isPermanentRefreshRejection(response.status, code),
      });
    }

    const tokens = await response.json().catch(() => null);
    if (!tokens) throw new CodexRefreshError('refresh response was not valid json', response.status);

    const next = applyRefresh(tokens, current, Date.now());
    if (!next) throw new CodexRefreshError('refresh response missing access token', response.status);

    if (row.storage === 'account_resource') {
      // Unconditional: OpenAI rotates the refresh token on use, so this is now
      // the only login that works. A login that refreshes needs no reconnection.
      await db.update(accountSecretResources).set({
        valueEnc: encryptAccountSecret(row.accountId, JSON.stringify({ openai: next })),
        updatedAt: new Date(),
        needsReauthAt: null,
      }).where(and(eq(accountSecretResources.accountId, row.accountId), eq(accountSecretResources.secretId, row.secretId)));
    } else {
      await db.update(projectSecrets).set({
        valueEnc: encryptProjectSecret(projectId, JSON.stringify({ openai: next })),
        updatedAt: new Date(),
      }).where(eq(projectSecrets.secretId, row.secretId));
    }

    await recordAuditEvent({
      accountId: row.accountId,
      projectId,
      sessionId: row.sessionId,
      actorUserId: row.actorUserId,
      actorType: row.sessionId ? 'agent' : 'human',
      source: 'llm_gateway',
      action: 'secret.consumer.refreshed',
      resourceType: 'project_secret',
      resourceId: row.secretId,
      metadata: {
        identifier: CODEX_AUTH_JSON_SECRET_NAME,
        consumer: 'llm_gateway',
        value_source: row.storage === 'account_resource' ? 'account_resource' : row.ownerUserId ? 'personal' : 'shared',
        upstream_status: response.status,
      },
    });
    return next;
  } catch (err) {
    const failure =
      err instanceof CodexRefreshError
        ? err
        : new CodexRefreshError(err instanceof Error ? err.message : 'network error');
    if (failure.permanent) await markNeedsReauth(row);
    await recordAuditEvent({
      accountId: row.accountId,
      projectId,
      sessionId: row.sessionId,
      actorUserId: row.actorUserId,
      actorType: row.sessionId ? 'agent' : 'human',
      source: 'llm_gateway',
      outcome: 'failure',
      action: 'secret.consumer.refresh_failed',
      resourceType: 'project_secret',
      resourceId: row.secretId,
      metadata: {
        identifier: CODEX_AUTH_JSON_SECRET_NAME,
        consumer: 'llm_gateway',
        value_source: row.storage === 'account_resource' ? 'account_resource' : row.ownerUserId ? 'personal' : 'shared',
        ...(upstreamStatus === undefined ? {} : { upstream_status: upstreamStatus }),
        permanent: failure.permanent,
        ...(failure.code ? { error_code: failure.code } : {}),
      },
    });
    throw failure;
  }
}

function refreshSingleFlight(
  projectId: string,
  row: SecretRow,
  current: StoredCodexAuth,
  fetchImpl: FetchImpl,
): Promise<StoredCodexAuth | null> {
  const existing = inflightRefresh.get(row.secretId);
  if (existing) return existing;
  const pending = refreshAndPersist(projectId, row, current, fetchImpl).finally(() => inflightRefresh.delete(row.secretId));
  inflightRefresh.set(row.secretId, pending);
  return pending;
}

export async function resolveCodexCredential(
  projectId: string,
  userId: string,
  fetchImpl: FetchImpl = (input, init) => fetch(input, init),
  context: CodexCredentialContext = {},
): Promise<CodexCredential | null> {
  const row = await loadCodexRow(projectId, userId, context);
  if (!row) return null;

  return resolveCodexRowCredential(projectId, row, fetchImpl);
}

/** The caller already resolved the session pool with member and grant checks.
 * Refresh writes back only the selected account resource, never a project row. */
export async function resolveCodexAccountCredential(input: {
  projectId: string; accountId: string; sessionId: string | null; userId: string;
  secretId: string; value: string | null; updatedAt: Date;
}, fetchImpl: FetchImpl = (request, init) => fetch(request, init)): Promise<CodexCredential | null> {
  return resolveCodexRowCredential(input.projectId, {
    storage: 'account_resource', accountId: input.accountId, secretId: input.secretId,
    ownerUserId: input.userId, value: input.value, actorUserId: input.userId,
    sessionId: input.sessionId, loadedUpdatedAt: input.updatedAt,
  }, fetchImpl);
}

async function resolveCodexRowCredential(
  projectId: string, row: SecretRow, fetchImpl: FetchImpl,
): Promise<CodexCredential | null> {
  let stored = row.value === null ? null : parseCodexAuth(row.value);
  if (!stored?.access) {
    // A login that cannot be read never yields a token; only a reconnect fixes it.
    await markNeedsReauth(row);
    return null;
  }

  if (needsRefresh(stored, Date.now())) {
    try {
      const refreshed = await refreshSingleFlight(projectId, row, stored, fetchImpl);
      if (refreshed?.access) stored = refreshed;
    } catch (err) {
      // Grace period: a refresh blip shouldn't fail every Codex request. If the
      // current token is still within its validity window, keep using it; only
      // surface the error once it has genuinely expired.
      if (!tokenStillValid(stored, Date.now())) throw err;
    }
  }

  const access = stored.access;
  if (!access) return null;
  return { access, accountId: stored.accountId };
}
