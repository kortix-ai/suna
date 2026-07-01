import { and, eq, isNull, or } from 'drizzle-orm';
import { projectSecrets } from '@kortix/db';
import { decryptProjectSecret, encryptProjectSecret } from '../../projects/secrets';
import { runLlmGatewayDatabase, runLlmGatewayFetch } from '../effect';
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
  secretId: string;
  ownerUserId: string | null;
  valueEnc: string;
}

async function loadCodexRow(projectId: string, userId: string): Promise<SecretRow | null> {
  const rows = await runLlmGatewayDatabase((database) =>
    database
      .select({
        secretId: projectSecrets.secretId,
        ownerUserId: projectSecrets.ownerUserId,
        valueEnc: projectSecrets.valueEnc,
      })
      .from(projectSecrets)
      .where(and(
        eq(projectSecrets.projectId, projectId),
        eq(projectSecrets.name, CODEX_AUTH_JSON_SECRET_NAME),
        or(isNull(projectSecrets.ownerUserId), eq(projectSecrets.ownerUserId, userId)),
      )),
  );
  if (!rows.length) return null;
  return rows.find((r) => r.ownerUserId === userId) ?? rows.find((r) => r.ownerUserId === null) ?? null;
}

const inflightRefresh = new Map<string, Promise<StoredCodexAuth | null>>();

async function refreshAndPersist(
  projectId: string,
  row: SecretRow,
  current: StoredCodexAuth,
  fetchImpl: FetchImpl,
): Promise<StoredCodexAuth | null> {
  if (!current.refresh) return null;

  let response: Response;
  try {
    response = await fetchImpl(`${OPENAI_AUTH_BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: buildRefreshBody(current.refresh),
    });
  } catch (err) {
    throw new CodexRefreshError(err instanceof Error ? err.message : 'network error');
  }
  if (!response.ok) throw new CodexRefreshError('upstream rejected refresh', response.status);

  const tokens = await response.json().catch(() => null);
  if (!tokens) throw new CodexRefreshError('refresh response was not valid json', response.status);

  const next = applyRefresh(tokens, current, Date.now());
  if (!next) throw new CodexRefreshError('refresh response missing access token', response.status);

  await runLlmGatewayDatabase((database) =>
    database
      .update(projectSecrets)
      .set({ valueEnc: encryptProjectSecret(projectId, JSON.stringify({ openai: next })), updatedAt: new Date() })
      .where(eq(projectSecrets.secretId, row.secretId)),
  );

  return next;
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
  fetchImpl: FetchImpl = (input, init) => runLlmGatewayFetch(input, init),
): Promise<CodexCredential | null> {
  const row = await loadCodexRow(projectId, userId);
  if (!row) return null;

  let stored = parseCodexAuth(decryptProjectSecret(projectId, row.valueEnc));
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
