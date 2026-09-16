import { eq } from 'drizzle-orm';
import { projectSecrets } from '@kortix/db';
import { db } from '../../shared/db';
import {
  encryptProjectSecret,
  resolveProjectSecretForConsumer,
} from '../../projects/secrets';
import { recordAuditEvent } from '../../shared/audit';
import {
  CodexRefreshError,
  OPENAI_AUTH_BASE,
  applyRefresh,
  buildRefreshBody,
  needsRefresh,
  parseCodexAuth,
  tokenStillValid,
  type CodexCredential,
  type StoredCodexAuth,
} from './codex-core';

export { CHATGPT_CODEX_BASE_URL, CODEX_USER_AGENT, CodexRefreshError } from './codex-core';
export type { CodexCredential } from './codex-core';

const CODEX_AUTH_JSON_SECRET_NAME = 'CODEX_AUTH_JSON';

type FetchImpl = (input: string, init: RequestInit) => Promise<Response>;

interface SecretRow {
  accountId: string;
  secretId: string;
  ownerUserId: string | null;
  value: string;
  actorUserId: string;
  sessionId: string | null;
}

interface CodexCredentialContext {
  accountId?: string;
  sessionId?: string | null;
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
    principalUserId: userId,
    name: CODEX_AUTH_JSON_SECRET_NAME,
    consumer: 'llm_gateway',
  });
  return resolved
    ? {
        ...resolved,
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
    if (!response.ok) throw new CodexRefreshError('upstream rejected refresh', response.status);

    const tokens = await response.json().catch(() => null);
    if (!tokens) throw new CodexRefreshError('refresh response was not valid json', response.status);

    const next = applyRefresh(tokens, current, Date.now());
    if (!next) throw new CodexRefreshError('refresh response missing access token', response.status);

    await db
      .update(projectSecrets)
      .set({
        valueEnc: encryptProjectSecret(projectId, JSON.stringify({ openai: next })),
        updatedAt: new Date(),
      })
      .where(eq(projectSecrets.secretId, row.secretId));

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
        value_source: row.ownerUserId ? 'personal' : 'shared',
        upstream_status: response.status,
      },
    });
    return next;
  } catch (err) {
    const failure =
      err instanceof CodexRefreshError
        ? err
        : new CodexRefreshError(err instanceof Error ? err.message : 'network error');
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
        value_source: row.ownerUserId ? 'personal' : 'shared',
        ...(upstreamStatus === undefined ? {} : { upstream_status: upstreamStatus }),
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

  let stored = parseCodexAuth(row.value);
  if (!stored?.access) return null;

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
