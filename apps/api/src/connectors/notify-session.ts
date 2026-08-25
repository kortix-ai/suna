/**
 * "The connector you were blocked on is connected now" — delivered to the agent
 * that asked, without the human having to type "done".
 *
 * The agent mints a connect link mid-turn and stops. Before this module the
 * only way the loop learned the account landed was a human typing a message,
 * so the common outcome was the agent re-minting a second link on its next run
 * and posting it again. The finalize call is the one place that knows BOTH that
 * the credential landed AND which session asked for it, so it owns the
 * notification — the same contract the Pipedream webhook deliberately opts out
 * of (see the comment on /webhook/pipedream).
 *
 * Two finalize surfaces share this: the hosted setup-link page
 * (setup-links/public-app.ts) and the in-session Connect button, which reaches
 * POST /connectors/projects/:projectId/connectors/:slug/connect/finalize.
 *
 * Best-effort by construction. The credential is saved before this runs; a
 * failure here must never turn a successful connect into an error.
 */
import { projectSessions } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../shared/db';

/** Exported for tests. The text delivered to the requesting session's agent. */
export function connectorConnectedPrompt(slug: string, app: string): string {
  const appLabel = app && app !== slug ? `${app} (connector \`${slug}\`)` : `\`${slug}\``;
  return (
    `The ${appLabel} connector was just connected and its credential is saved on ` +
    'this project. Verify it with `kortix connectors ls`, then continue the task ' +
    'that was blocked on it. Do not mint a new connect link for this connector.'
  );
}

/**
 * Hand the requesting agent a durable follow-up prompt through the
 * session-lifecycle queue — the same path approval-resume uses.
 *
 * Gated on `running`: a stopped or hibernated session reads the credential from
 * the store on its next run anyway, and finalizing a connect must never boot a
 * sandbox on its own.
 */
export async function notifyConnectorSession(
  sessionId: string,
  projectId: string,
  actorUserId: string | null,
  slug: string,
  app: string,
): Promise<void> {
  try {
    const [session] = await db
      .select({
        status: projectSessions.status,
        accountId: projectSessions.accountId,
        metadata: projectSessions.metadata,
      })
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, sessionId))
      .limit(1);
    if (session?.status !== 'running') return;
    const meta = (session.metadata ?? {}) as Record<string, unknown>;
    if (typeof meta.deletedAt === 'string') return;
    const { enqueueContinueSessionCommand, drainSessionLifecycleQueue } = await import(
      '../projects/session-lifecycle'
    );
    await enqueueContinueSessionCommand({
      source: 'system:connector-connected',
      projectId,
      accountId: session.accountId,
      sessionId,
      actorUserId,
      text: connectorConnectedPrompt(slug, app),
    });
    drainSessionLifecycleQueue({ limit: 1 }).catch(() => {});
    console.info('[connectors] connector connected, session notified', { sessionId, slug });
  } catch (err) {
    console.warn('[connectors] failed to notify session of connector connect:', err);
  }
}
