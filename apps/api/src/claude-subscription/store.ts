/**
 * A member's Claude subscription login: the long-lived token `claude
 * setup-token` printed, one per (account, user), encrypted with the account
 * key. This module is the only reader of `kortix.claude_subscription_logins`.
 *
 * The token has one use: Claude Code reads it as `CLAUDE_CODE_OAUTH_TOKEN` in
 * that same member's sessions. Nothing here returns it to a client, logs it,
 * or hands it to the LLM gateway.
 */
import { and, eq, isNull, isNotNull } from 'drizzle-orm';
import { accountTokens, claudeSubscriptionLogins, projects } from '@kortix/db';
import { db } from '../shared/db';
import { logger } from '../lib/logger';
import { decryptAccountSecret, encryptAccountSecret } from '../secrets/account-resource';

export type ClaudeLoginSource = 'setup_token' | 'pasted';

export interface ClaudeLoginStatus {
  connected: boolean;
  source: ClaudeLoginSource | null;
  connectedAt: string | null;
  /** False when the stored value cannot be decrypted: the member signs in again. */
  usable: boolean;
}

export async function claudeLoginStatus(accountId: string, userId: string): Promise<ClaudeLoginStatus> {
  const [row] = await db
    .select({ valueEnc: claudeSubscriptionLogins.valueEnc, source: claudeSubscriptionLogins.source, updatedAt: claudeSubscriptionLogins.updatedAt })
    .from(claudeSubscriptionLogins)
    .where(and(eq(claudeSubscriptionLogins.accountId, accountId), eq(claudeSubscriptionLogins.userId, userId)))
    .limit(1);
  if (!row) return { connected: false, source: null, connectedAt: null, usable: false };
  let usable = true;
  try {
    decryptAccountSecret(accountId, row.valueEnc);
  } catch {
    usable = false;
  }
  return { connected: true, source: row.source as ClaudeLoginSource, connectedAt: row.updatedAt.toISOString(), usable };
}

export async function saveClaudeLogin(accountId: string, userId: string, token: string, source: ClaudeLoginSource): Promise<void> {
  const now = new Date();
  const valueEnc = encryptAccountSecret(accountId, token);
  await db
    .insert(claudeSubscriptionLogins)
    .values({ accountId, userId, valueEnc, source, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [claudeSubscriptionLogins.accountId, claudeSubscriptionLogins.userId],
      set: { valueEnc, source, updatedAt: now },
    });
}

/** True when a login was removed. */
export async function deleteClaudeLogin(accountId: string, userId: string): Promise<boolean> {
  const removed = await db
    .delete(claudeSubscriptionLogins)
    .where(and(eq(claudeSubscriptionLogins.accountId, accountId), eq(claudeSubscriptionLogins.userId, userId)))
    .returning({ userId: claudeSubscriptionLogins.userId });
  return removed.length > 0;
}

/** The member's token, or null when they have none or it cannot be decrypted. */
export async function readClaudeToken(accountId: string, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ valueEnc: claudeSubscriptionLogins.valueEnc })
    .from(claudeSubscriptionLogins)
    .where(and(eq(claudeSubscriptionLogins.accountId, accountId), eq(claudeSubscriptionLogins.userId, userId)))
    .limit(1);
  if (!row?.valueEnc) return null;
  try {
    return decryptAccountSecret(accountId, row.valueEnc);
  } catch {
    logger.warn('[claude-subscription] a stored login cannot be decrypted', { accountId, userId });
    return null;
  }
}

/** The token of a member in the account that owns `projectId`. */
export async function readClaudeTokenForProject(projectId: string, userId: string): Promise<string | null> {
  const [project] = await db.select({ accountId: projects.accountId }).from(projects).where(eq(projects.projectId, projectId)).limit(1);
  return project?.accountId ? readClaudeToken(project.accountId, userId) : null;
}

/**
 * The person a session's live token acts for (`on_behalf_of`): the member who
 * prompts it, in their own or a shared session. Null for an unattended run.
 */
export async function sessionPerson(sessionId: string): Promise<string | null> {
  const [row] = await db
    .select({ onBehalfOf: accountTokens.onBehalfOfUserId })
    .from(accountTokens)
    .where(
      and(
        eq(accountTokens.sessionId, sessionId),
        eq(accountTokens.status, 'active'),
        isNull(accountTokens.revokedAt),
        isNotNull(accountTokens.serviceAccountId),
      ),
    )
    .limit(1);
  return row?.onBehalfOf ?? null;
}

/** The Claude token a session's box gets: its person's, or null. */
export async function claudeTokenForSession(projectId: string, sessionId: string): Promise<string | null> {
  const person = await sessionPerson(sessionId);
  return person ? readClaudeTokenForProject(projectId, person) : null;
}
