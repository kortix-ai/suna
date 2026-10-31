/**
 * A turn on a Claude subscription model needs a Claude account the LLM gateway
 * will use for it: the session's selected accounts, the personal-key owner's
 * own account, or one shared with the project (`claude-subscription/accounts.ts`).
 * Without one, the turn is refused before it reaches the box, with a code the
 * clients turn into a Connect button.
 */
import { eq } from 'drizzle-orm';
import { projectSessions } from '@kortix/db';
import { db } from '../../shared/db';
import { isClaudeAgentModelRef } from '../../llm-gateway/resolution/claude-agent';
import { hasClaudeCredential } from '../../claude-subscription/accounts';
import { resolveSessionPersonalOwner } from '../lib/personal-resources';

export { CLAUDE_SUBSCRIPTION_REQUIRED, CLAUDE_SUBSCRIPTION_REQUIRED_MESSAGE, claudeSubscriptionRequiredBody } from '../../llm-gateway/resolution/claude-agent';

/** A prompt body's model as a ref: `{providerID, modelID}` or a plain string. */
export function promptModelRef(raw: unknown): string | null {
  if (typeof raw === 'string') return raw.trim() || null;
  if (!raw || typeof raw !== 'object') return null;
  const model = raw as { providerID?: unknown; modelID?: unknown };
  if (typeof model.providerID !== 'string' || typeof model.modelID !== 'string') return null;
  return `${model.providerID}/${model.modelID}`;
}

/** The model a session runs when a prompt names none (`metadata.opencode_model`). */
export async function sessionModelPin(sessionId: string): Promise<string | null> {
  const [row] = await db
    .select({ metadata: projectSessions.metadata })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  const metadata = (row?.metadata ?? {}) as Record<string, unknown>;
  return typeof metadata.opencode_model === 'string' ? metadata.opencode_model : null;
}

/**
 * The model ref that makes this turn need a Claude account it cannot use, or
 * null when the turn may go on. `model` is the turn's model: the prompt's,
 * else the session's. `sessionId` absent: a new session private to `userId`.
 */
export async function missingClaudeSubscription(input: {
  accountId: string;
  projectId: string;
  sessionId?: string | null;
  userId: string | null;
  model: string | null;
}): Promise<string | null> {
  if (!input.model || !isClaudeAgentModelRef(input.model)) return null;
  if (!input.userId) return input.model;
  const personalUserId = input.sessionId
    ? await resolveSessionPersonalOwner({ projectId: input.projectId, sessionId: input.sessionId, legacyUserId: input.userId, accountId: input.accountId })
    : input.userId;
  const usable = await hasClaudeCredential({
    accountId: input.accountId, projectId: input.projectId, userId: input.userId,
    sessionId: input.sessionId ?? null, personalUserId,
  });
  return usable ? null : input.model;
}
