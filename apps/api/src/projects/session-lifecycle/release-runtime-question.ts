import { resolveSessionOpencodeEndpoint } from './runtime-client';
import { WORKSPACE, runtimeServesActions, runtimeVerbPaths, sessionRuntimeFetch } from './runtime-fetch';

export type ReleaseOutcome = 'released' | 'already_answered' | 'unreachable';

/**
 * Release the runtime's BLOCKING `question` call from the server.
 *
 * The `question` tool waits for an answer. In the dashboard the UI answers it
 * through the runtime. In a chat channel nobody can: the answer
 * arrives later, as an ordinary message that starts a NEW turn. So a channel
 * session has to release the call with a sentinel, or the turn hangs until the
 * box is parked.
 *
 * That release used to live only in the sandbox daemon
 * (its OpenCode adapter, since deleted), gated on SLACK_THREAD_TS / SLACK_CHANNEL_ID.
 * A Teams session carries MS_TEAMS_* instead, so the gate returned null and a
 * Teams agent that asked a question hung — after the card had already been
 * posted, because the relay that posts it is ungated. The daemon now accepts
 * Teams, but the daemon is IMAGE-BAKED: that fix reaches only sandboxes built
 * after it deploys, and every existing Teams sandbox would still hang.
 *
 * Doing it here reaches every sandbox the moment the API deploys. It mirrors
 * `abortRuntimeTurn`: same endpoint resolution, same runtime headers.
 *
 * A second release is harmless: the first reply answers the question and
 * removes it, and any later reply returns `404`. So when a new-image daemon
 * releases too, whichever lands second is a no-op — reported here as
 * `already_answered`, which callers treat as success. A box with the
 * session-log actions (`runtime.actions.v1`) takes the reply on its question
 * route; an older one on the compatibility route.
 */
export async function releaseRuntimeQuestion(
  sessionId: string,
  requestId: string,
  answers: string[][],
): Promise<ReleaseOutcome> {
  if (!sessionId || !requestId) return 'unreachable';
  try {
    const resolved = await resolveSessionOpencodeEndpoint(sessionId);
    if (!resolved) return 'unreachable';
    const native = await runtimeServesActions(resolved.externalId, async () => resolved.endpoint);
    const path = native
      ? runtimeVerbPaths.questionReply(requestId)
      : `/question/${encodeURIComponent(requestId)}/reply?directory=${encodeURIComponent(WORKSPACE)}`;
    const res = await sessionRuntimeFetch(resolved.endpoint, 'POST', path, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers }),
    });
    if (res.ok) return 'released';
    if (res.status === 404) return 'already_answered';
    return 'unreachable';
  } catch {
    return 'unreachable';
  }
}
