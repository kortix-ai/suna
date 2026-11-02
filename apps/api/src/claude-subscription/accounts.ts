/**
 * Claude accounts: a member's Claude Pro or Max login (the token `claude
 * setup-token` printed), stored as a named provider account exactly like a
 * ChatGPT account (`secrets/provider-accounts.ts`): private to its creator
 * until shared, chosen per request by the LLM gateway, never sent to a sandbox.
 *
 * Which account a request uses, in the ChatGPT order:
 *   1. the session's selected accounts (`session_provider_secret_pools`);
 *   2. the personal-key owner's own newest account (not for a gateway API key);
 *   3. the accounts shared with the project that the principal may use.
 * A resting account (after a rate or usage limit) and one refused by Anthropic
 * (needs reconnection) are skipped.
 */
import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { accountSecretResources, sessionProviderSecretPools } from '@kortix/db';
import { GatewayResolutionError, type ClaudeCodeCredentials } from '@kortix/llm-gateway';
import { CLAUDE_AGENT_PROVIDER_ID } from '@kortix/api-contract/claude-agent';
import { getProjectGatewayResolution } from '../repositories/project-model-access';
import { db } from '../shared/db';
import { logger } from '../lib/logger';
import {
  listUsableGatewaySecrets,
  readAccountSecret,
  resolveDefaultProviderAccountSecret,
  resolveProjectSharedProviderSecrets,
  resolveSessionProviderSecrets,
  type ResolvedAccountSecret,
} from '../secrets/account-resource';
import type { ProviderAccountKind } from '../secrets/provider-accounts';

export const CLAUDE_ACCOUNT: ProviderAccountKind = { providerId: 'claude-agent', name: 'CLAUDE_CODE_OAUTH_TOKEN', label: 'Claude' };

/** Who asks for a Claude account: the gateway principal's fields. */
export interface ClaudeAccountPrincipal {
  accountId: string;
  projectId: string;
  userId: string;
  sessionId?: string | null;
  /** A gateway API key: no member, so only accounts shared with the whole project. */
  keyId?: string;
  /** Whose personal accounts count; null = none (a shared or unattended session). */
  personalUserId: string | null;
}

export interface ClaudeCredential {
  secretId: string;
  label: string;
  token: string;
}

function accountsResting(subject: string, retryAfterSeconds: number | undefined): GatewayResolutionError {
  const suggestion = 'Retry after the cooldown, or connect another Claude account.';
  if (retryAfterSeconds === undefined || retryAfterSeconds <= 60) {
    return new GatewayResolutionError('provider_pool_rate_limited', `${subject} are cooling down.`, suggestion,
      retryAfterSeconds, retryAfterSeconds);
  }
  const hours = retryAfterSeconds / 3600;
  const wait = hours >= 48 ? `${Math.round(hours / 24)} days`
    : hours >= 2 ? `${Math.round(hours)} hours`
    : `${Math.ceil(retryAfterSeconds / 60)} minutes`;
  return new GatewayResolutionError('provider_pool_rate_limited',
    `${subject} reached their usage limit. The first resets in ${wait}.`,
    'Choose another model, or connect another Claude account.', undefined, retryAfterSeconds);
}

const notConnected = () => new GatewayResolutionError('provider_not_connected',
  'Connect Claude to use this model.', 'Sign in with Claude under Models → Providers → Anthropic, then retry.');

function needsReconnection(labels: string[], scope: 'selected' | 'shared' | 'own'): GatewayResolutionError {
  const named = labels.slice(0, 3).map((label) => `"${label}"`).join(', ');
  const more = labels.length > 3 ? ` and ${labels.length - 3} more` : '';
  const message = scope === 'own'
    ? `Your Claude account ${named} needs reconnection.`
    : labels.length === 1
      ? `The ${scope === 'shared' ? 'Claude account shared with this project' : 'selected Claude account'} ${named} needs reconnection.`
      : `${labels.length} ${scope === 'shared' ? 'Claude accounts shared with this project' : 'selected Claude accounts'} need reconnection: ${named}${more}.`;
  const suggestion = scope === 'own'
    ? 'Reconnect it under Models → Providers → Anthropic, then retry.'
    : 'The member who connected it must reconnect it, or select another Claude account.';
  return new GatewayResolutionError('provider_reauth_required', message, suggestion);
}

/** The accounts among `secrets` that Anthropic has not refused, with their tokens. */
async function usable(accountId: string, secrets: ResolvedAccountSecret[]): Promise<{ credentials: ClaudeCredential[]; refused: string[] }> {
  if (!secrets.length) return { credentials: [], refused: [] };
  const flagged = new Set((await db.select({ secretId: accountSecretResources.secretId })
    .from(accountSecretResources)
    .where(and(
      eq(accountSecretResources.accountId, accountId),
      inArray(accountSecretResources.secretId, secrets.map((secret) => secret.secretId)),
      sql`${accountSecretResources.needsReauthAt} is not null`,
    ))).map((row) => row.secretId));
  const credentials: ClaudeCredential[] = [];
  const refused: string[] = [];
  for (const secret of secrets) {
    if (flagged.has(secret.secretId) || !secret.value) refused.push(secret.label);
    else credentials.push({ secretId: secret.secretId, label: secret.label, token: secret.value });
  }
  return { credentials, refused };
}

async function sharedCredentials(principal: ClaudeAccountPrincipal): Promise<ClaudeCredential[] | GatewayResolutionError | null> {
  const shared = await resolveProjectSharedProviderSecrets({
    accountId: principal.accountId, projectId: principal.projectId, userId: principal.userId,
    grantUserId: principal.keyId ? null : principal.personalUserId,
    providerId: CLAUDE_ACCOUNT.providerId, name: CLAUDE_ACCOUNT.name,
  });
  if (shared.secrets.length) {
    const { credentials, refused } = await usable(principal.accountId, shared.secrets);
    return credentials.length ? credentials : needsReconnection(refused, 'shared');
  }
  if (shared.coolingDown) return accountsResting('All Claude accounts shared with this project', shared.retryAfterSeconds);
  return null;
}

/**
 * The Claude accounts a request may use, best first. Throws a
 * GatewayResolutionError that names why none is usable.
 */
export async function resolveClaudeCredentials(principal: ClaudeAccountPrincipal, options: { probe?: boolean } = {}): Promise<ClaudeCredential[]> {
  if (principal.sessionId) {
    const pool = await resolveSessionProviderSecrets({
      accountId: principal.accountId, projectId: principal.projectId, sessionId: principal.sessionId,
      // A probe (a turn gate, the picker) reads the pool without rotating it.
      ...(options.probe ? { advanceIndex: false } : {}),
      userId: principal.userId, grantUserId: principal.personalUserId,
      providerId: CLAUDE_ACCOUNT.providerId, name: CLAUDE_ACCOUNT.name,
    });
    if (pool.configured) {
      if (!pool.secrets.length) {
        throw pool.coolingDown
          ? accountsResting('All selected Claude accounts', pool.retryAfterSeconds)
          : new GatewayResolutionError('provider_not_connected', 'No usable Claude account is selected for this session.',
            'Select a Claude account you may use in session settings.');
      }
      const { credentials, refused } = await usable(principal.accountId, pool.secrets);
      if (credentials.length) return credentials;
      throw needsReconnection(refused, 'selected');
    }
  }
  if (principal.personalUserId && !principal.keyId) {
    const own = await resolveDefaultProviderAccountSecret(principal.accountId, principal.projectId, principal.personalUserId, CLAUDE_ACCOUNT);
    if (own && !own.restingSeconds && !own.needsReauth && own.value) {
      return [{ secretId: own.secretId, label: own.label, token: own.value }];
    }
    if (own) {
      // Resting or refused: an account shared with the project may serve instead.
      const shared = await sharedCredentials(principal);
      if (Array.isArray(shared)) return shared;
      if (own.restingSeconds) throw accountsResting('Your Claude accounts', own.restingSeconds);
      throw needsReconnection([own.label], 'own');
    }
  }
  const shared = await sharedCredentials(principal);
  if (Array.isArray(shared)) return shared;
  throw shared ?? notConnected();
}

/** Whether a request with this principal has a Claude account to use now. */
export async function hasClaudeCredential(principal: ClaudeAccountPrincipal): Promise<boolean> {
  try {
    return (await resolveClaudeCredentials(principal, { probe: true })).length > 0;
  } catch (err) {
    if (err instanceof GatewayResolutionError) return false;
    throw err;
  }
}

/** The Claude accounts `userId` may use in the project (their own and shared ones), without values. */
export async function countUsableClaudeAccounts(accountId: string, projectId: string, userId: string): Promise<number> {
  const rows = await listUsableGatewaySecrets({
    accountId, projectId, userId, providerId: CLAUDE_ACCOUNT.providerId, name: CLAUDE_ACCOUNT.name,
  });
  if (!rows.length) return 0;
  const refused = await db.select({ secretId: accountSecretResources.secretId }).from(accountSecretResources).where(and(
    eq(accountSecretResources.accountId, accountId),
    inArray(accountSecretResources.secretId, rows.map((row) => row.secretId)),
    sql`${accountSecretResources.needsReauthAt} is not null`,
  ));
  return rows.length - refused.length;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * Anthropic refused this account's token (401): mark it for reconnection, so
 * the next request skips it and its owner sees "Needs reconnection". Only when
 * the stored token is still the refused one: a reconnect since then wins.
 */
export async function markClaudeAccountRefused(accountId: string, secretId: string, failedKeySha256: string): Promise<boolean> {
  const [row] = await db.select({ valueEnc: accountSecretResources.valueEnc }).from(accountSecretResources).where(and(
    eq(accountSecretResources.accountId, accountId),
    eq(accountSecretResources.secretId, secretId),
    eq(accountSecretResources.providerId, CLAUDE_ACCOUNT.providerId),
    isNull(accountSecretResources.needsReauthAt),
  )).limit(1);
  if (!row) return false;
  const current = readAccountSecret(accountId, secretId, row.valueEnc);
  if (!current || sha256(current) !== failedKeySha256) return false;
  await db.update(accountSecretResources)
    .set({ needsReauthAt: sql`coalesce(${accountSecretResources.needsReauthAt}, now())` })
    .where(and(eq(accountSecretResources.accountId, accountId), eq(accountSecretResources.secretId, secretId)));
  logger.warn('[claude-accounts] Anthropic refused a Claude account; it needs reconnection', { secretId });
  return true;
}

/** Delete the caller's own Claude accounts in a project (`kortix providers rm claude`). Returns how many. */
export async function deleteOwnClaudeAccounts(accountId: string, projectId: string, userId: string): Promise<number> {
  return db.transaction(async (tx) => {
    const own = await tx.select({ secretId: accountSecretResources.secretId }).from(accountSecretResources).where(and(
      eq(accountSecretResources.accountId, accountId),
      eq(accountSecretResources.projectId, projectId),
      eq(accountSecretResources.providerId, CLAUDE_ACCOUNT.providerId),
      eq(accountSecretResources.createdBy, userId),
    ));
    for (const { secretId } of own) {
      await tx.update(sessionProviderSecretPools)
        .set({ secretIds: sql`${sessionProviderSecretPools.secretIds} - ${secretId}`, updatedAt: new Date() })
        .where(sql`${sessionProviderSecretPools.secretIds} @> jsonb_build_array(${secretId}::text)`);
      await tx.delete(accountSecretResources).where(eq(accountSecretResources.secretId, secretId));
    }
    return own.length;
  });
}

/** The answer the gateway's Claude Code passthrough needs: the accounts to try, or why none. */
export async function claudeCredentialsForGateway(principal: {
  accountId: string;
  projectId?: string;
  userId: string;
  sessionId?: string | null;
  keyId?: string;
  personalUserId?: string | null;
}, _model: string | null): Promise<ClaudeCodeCredentials> {
  if (!principal.projectId) {
    return { error: { status: 400, code: 'provider_not_connected', message: 'Claude models run in a project session.', suggestion: 'Use a project session token.' } };
  }
  // The provider switch applies to every call. A single turned-off model is
  // enforced where a turn's model is chosen (picker, session model change):
  // Claude Code also calls a smaller model on its own for side steps, and a
  // turn on an allowed model must not fail on that.
  const resolution = await getProjectGatewayResolution(principal.projectId);
  if (resolution.access.disabledProviders.includes(CLAUDE_AGENT_PROVIDER_ID)) {
    return { error: {
      status: 403, code: 'provider_disabled',
      message: 'Claude subscription models are turned off in this project.',
      suggestion: 'Turn them on under Models, or choose another model.',
    } };
  }
  try {
    const credentials = await resolveClaudeCredentials({
      accountId: principal.accountId, projectId: principal.projectId, userId: principal.userId,
      sessionId: principal.sessionId ?? null, keyId: principal.keyId,
      personalUserId: principal.personalUserId === undefined ? principal.userId : principal.personalUserId,
    });
    return { credentials: credentials.map((credential) => ({ secretId: credential.secretId, apiKey: credential.token })) };
  } catch (err) {
    if (!(err instanceof GatewayResolutionError)) throw err;
    return { error: {
      status: err.code === 'provider_pool_rate_limited' ? 429 : 400,
      code: err.code, message: err.message, suggestion: err.suggestion, retryAfterSeconds: err.retryAfterSeconds,
    } };
  }
}
