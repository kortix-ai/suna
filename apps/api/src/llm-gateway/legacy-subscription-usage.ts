/** Read existing subscription logins in place. Provider-account management stays in its original store. */
import type { SubscriptionUsage } from '@kortix/llm-gateway';
import { resolveProjectSecretForConsumer } from '../projects/surface';
import { SecretUndecryptableError } from '../secrets/undecryptable';
import { projectInAccount } from '../secrets/project-account';
import { CODEX_USER_AGENT } from './credentials/codex';
import { parseCodexAuth } from './credentials/codex-core';
import { codexAccountFromLogin, codexUsageFromBody, type SubscriptionAccount } from './subscription-usage';

interface Principal { accountId: string; projectId: string; userId: string }
export type LegacySubscriptionStorage = 'project';
export interface LegacySubscriptionConnection {
  secret_id: string;
  account_id: string;
  project_id: string;
  access_mode: 'project' | 'members';
  label: string;
  provider_id: 'codex';
  name: string;
  consumer: 'llm_gateway';
  strategy: 'broker';
  active: boolean;
  cooldown_until: null;
  needs_reauth_at: null;
  usage: SubscriptionUsage | null;
  provider_account: SubscriptionAccount | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  granted_user_ids: string[];
  can_use: boolean;
  status: 'ok' | 'undecryptable';
  storage: LegacySubscriptionStorage;
}
type FetchImpl = (input: string, init: RequestInit) => Promise<Response>;
type UsageResult = { usage: SubscriptionUsage | null; provider_account: SubscriptionAccount | null };
// replica-local: this bounded cache only reduces outbound reads. Every caller rechecks tenant binding and credential access before using it.
const recentReads = new Map<string, { expiresAt: number; pending: Promise<UsageResult> }>();

async function codexLogin(input: Principal) {
  if (!(await projectInAccount(input.accountId, input.projectId))) return null;
  return resolveProjectSecretForConsumer({ accountId: input.accountId, projectId: input.projectId,
    actorUserId: input.userId, principalUserId: input.userId,
    name: 'CODEX_AUTH_JSON', consumer: 'llm_gateway', throwWhenUndecryptable: true });
}
function metadata(input: Principal, storage: LegacySubscriptionStorage, secretId: string, updatedAt: Date, status: 'ok' | 'undecryptable'): LegacySubscriptionConnection {
  return { secret_id: secretId, account_id: input.accountId, project_id: input.projectId,
    access_mode: 'members', label: 'ChatGPT',
    provider_id: 'codex', name: 'CODEX_AUTH_JSON',
    consumer: 'llm_gateway', strategy: 'broker', active: true, cooldown_until: null, needs_reauth_at: null,
    usage: null, provider_account: null, created_by: '', created_at: updatedAt.toISOString(), updated_at: updatedAt.toISOString(),
    granted_user_ids: [], can_use: true, status, storage };
}

export async function listLegacySubscriptionConnections(input: Principal): Promise<LegacySubscriptionConnection[]> {
  const rows: LegacySubscriptionConnection[] = [];
  try {
    const login = await codexLogin(input);
    if (login && parseCodexAuth(login.value)) {
      const row = metadata(input, 'project', login.secretId, login.updatedAt, 'ok');
      row.access_mode = login.ownerUserId ? 'members' : 'project';
      row.created_by = login.ownerUserId ?? '';
      row.granted_user_ids = login.ownerUserId ? [login.ownerUserId] : [];
      row.provider_account = codexAccountFromLogin(login.value);
      rows.push(row);
    }
  } catch (error) {
    if (!(error instanceof SecretUndecryptableError)) throw error;
    // The consumer boundary exposes no row id when decryption fails. This disabled card uses the project id.
    rows.push(metadata(input, 'project', input.projectId, new Date(0), 'undecryptable'));
  }
  return rows;
}

async function readProvider(fetchImpl: FetchImpl, url: string, headers: Record<string, string>) {
  const response = await fetchImpl(url, { method: 'GET', headers, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  return response.json().catch(() => null);
}

/** Re-authorize the original store on every read; client ids never select another person's login. */
export async function refreshLegacySubscriptionUsage(input: Principal & { secretId: string; storage: LegacySubscriptionStorage }, fetchImpl: FetchImpl = (url, init) => fetch(url, init)):
Promise<{ usage: SubscriptionUsage | null; provider_account: SubscriptionAccount | null } | null> {
  if (input.storage === 'project') {
    let login;
    try { login = await codexLogin(input); } catch (error) {
      if (error instanceof SecretUndecryptableError) return null;
      throw error;
    }
    if (!login || login.secretId !== input.secretId) return null;
    // A usage read never rotates tokens or changes connection state.
    const credential = parseCodexAuth(login.value);
    if (!credential?.access) return { usage: null, provider_account: codexAccountFromLogin(login.value) };
    const headers: Record<string, string> = { authorization: `Bearer ${credential.access}`, 'user-agent': CODEX_USER_AGENT, accept: 'application/json' };
    if (credential.accountId) headers['chatgpt-account-id'] = credential.accountId;
    const cacheKey = `${login.secretId}:${login.updatedAt.getTime()}`;
    const cached = recentReads.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.pending;
    recentReads.delete(cacheKey);
    if (recentReads.size >= 512) {
      const oldest = recentReads.keys().next().value;
      if (oldest) recentReads.delete(oldest);
    }
    const pending = (async () => ({
      usage: codexUsageFromBody(await readProvider(fetchImpl, 'https://chatgpt.com/backend-api/wham/usage', headers)),
      provider_account: codexAccountFromLogin(login.value),
    }))();
    recentReads.set(cacheKey, { expiresAt: Date.now() + 60_000, pending });
    return pending;
  }
  return null;
}
