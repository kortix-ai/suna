/**
 * A turn on a Claude subscription model needs the prompting person's Claude
 * login. Without one, the turn is refused before it reaches the box, with a
 * code the clients turn into a Connect button.
 */
import { eq } from 'drizzle-orm';
import { projectSessions } from '@kortix/db';
import { db } from '../shared/db';
import { isClaudeAgentModelRef } from '../llm-gateway/resolution/claude-agent';
import { readClaudeToken } from './store';

export { CLAUDE_SUBSCRIPTION_REQUIRED, CLAUDE_SUBSCRIPTION_REQUIRED_MESSAGE, claudeSubscriptionRequiredBody } from '../llm-gateway/resolution/claude-agent';

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
 * The model ref that makes this turn need a Claude login the person does not
 * have, or null when the turn may go on. `model` is the turn's model: the
 * prompt's, else the session's.
 */
export async function missingClaudeSubscription(input: {
  accountId: string;
  userId: string | null;
  model: string | null;
}): Promise<string | null> {
  if (!input.model || !isClaudeAgentModelRef(input.model)) return null;
  if (input.userId && (await readClaudeToken(input.accountId, input.userId))) return null;
  return input.model;
}
