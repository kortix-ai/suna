import { getProjectSession } from '../rest/projects-client/sessions';
import { getClientForUrl } from '../runtime/client';
import { getSandboxUrlForExternalId } from './server-store/url-helpers';

/** The provider sandbox id out of a session's `sandbox_url` (`…/p/<id>/8000`), or null. */
export function externalIdFromSandboxUrl(sandboxUrl: string | null | undefined): string | null {
  if (!sandboxUrl) return null;
  const match = /\/p\/([^/]+)\/\d+\/?$/.exec(sandboxUrl);
  return match?.[1] ?? null;
}

/**
 * Answer the question the agent's `question` tool is BLOCKED on inside the
 * running sandbox — the interactive ask the session page answers over the
 * runtime — with one free-text answer per question.
 *
 * This is the last resort behind the durable question (`answerSessionQuestion`):
 * a dashboard session's question reaches the API only when the daemon relays
 * `question.asked`, and a question the relay missed still holds the agent's
 * turn open. Without this, a Monitoring "Approve" that only sends a prompt
 * leaves the agent waiting behind its own dialog.
 *
 * Resolves the session's own runtime from its `sandbox_url` — never the
 * process-wide active runtime, which may belong to a different session.
 *
 * @returns `'answered'` when a pending question was replied to, `'none'` when
 * the session is not running or has no pending question of its own.
 */
export async function answerSessionRuntimeQuestion(
  projectId: string,
  sessionId: string,
  answer: string,
): Promise<'answered' | 'none'> {
  const session = await getProjectSession(projectId, sessionId);
  if (session.status !== 'running') return 'none';
  const externalId = externalIdFromSandboxUrl(session.sandbox_url);
  if (!externalId) return 'none';

  const client = getClientForUrl(getSandboxUrlForExternalId(externalId));
  const listed = await client.question.list();
  if (listed.error) throw new Error(`runtime question list failed: ${JSON.stringify(listed.error)}`);
  const pending = (listed.data ?? []).filter(
    (q) => !session.opencode_session_id || q.sessionID === session.opencode_session_id,
  );
  const request = pending[0];
  if (!request) return 'none';

  const replied = await client.question.reply({
    requestID: request.id,
    answers: request.questions.map(() => [answer]),
  });
  if (replied.error) throw new Error(`runtime question reply failed: ${JSON.stringify(replied.error)}`);
  return 'answered';
}
