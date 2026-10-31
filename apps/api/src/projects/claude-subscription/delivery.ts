/**
 * Bring a changed Claude login to the boxes that use it now: every active
 * sandbox whose session token acts for the member (`on_behalf_of`). Each one
 * gets the ordinary per-session secret push, which carries the session
 * person's Claude token (`claudeOauthToken` on `POST /kortix/env`). A box that
 * sleeps gets the token at its next boot or prompt instead.
 */
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { accountTokens, projects, sessionSandboxes } from '@kortix/db';
import { db } from '../../shared/db';
import { logger } from '../../lib/logger';
import { syncSessionSecretsToSandbox } from '../lib/sandbox-env-sync';
import { runBounded } from '../lib/sandbox-env-push';

export async function pushClaudeLoginToSessions(accountId: string, userId: string): Promise<void> {
  const rows = await db
    .select({ projectId: sessionSandboxes.projectId, sessionId: sessionSandboxes.sessionId })
    .from(sessionSandboxes)
    .innerJoin(projects, eq(projects.projectId, sessionSandboxes.projectId))
    .innerJoin(
      accountTokens,
      and(
        eq(accountTokens.sessionId, sessionSandboxes.sessionId),
        eq(accountTokens.status, 'active'),
        isNull(accountTokens.revokedAt),
        isNotNull(accountTokens.serviceAccountId),
        eq(accountTokens.onBehalfOfUserId, userId),
      ),
    )
    .where(and(eq(projects.accountId, accountId), eq(sessionSandboxes.status, 'active')));
  await runBounded(rows, 4, async (row) => {
    const result = await syncSessionSecretsToSandbox(row.projectId, row.sessionId).catch((err) => {
      logger.warn('[claude-subscription] session push failed', {
        sessionId: row.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    });
    if (result && !result.ok) logger.warn('[claude-subscription] session push did not land', { sessionId: row.sessionId });
  });
}
