import { resolveSessionOpencodeEndpoint } from './engine';
import { sandboxRuntimeRequestHeaders } from '../sandbox-fetch';

const WORKSPACE = '/workspace';

export type ReleaseOutcome = 'released' | 'already_answered' | 'unreachable';

/**
 * Release OpenCode's BLOCKING `question` call from the server.
 *
 * OpenCode's `question` tool waits for an answer. In the dashboard the UI
 * answers it over OpenCode's own SSE. In a chat channel nobody can: the answer
 * arrives later, as an ordinary message that starts a NEW turn. So a channel
 * session has to release the call with a sentinel, or the turn hangs until the
 * box is parked.
 *
 * That release used to live only in the sandbox daemon
 * (`harness/open-code/boot.ts`), gated on SLACK_THREAD_TS / SLACK_CHANNEL_ID.
 * A Teams session carries MS_TEAMS_* instead, so the gate returned null and a
 * Teams agent that asked a question hung — after the card had already been
 * posted, because the relay that posts it is ungated. The daemon now accepts
 * Teams, but the daemon is IMAGE-BAKED: that fix reaches only sandboxes built
 * after it deploys, and every existing Teams sandbox would still hang.
 *
 * Doing it here reaches every sandbox the moment the API deploys. It mirrors
 * `abortRuntimeTurn`: same endpoint resolution, same runtime headers.
 *
 * A second release is harmless by OpenCode's own contract: the first reply
 * answers the question and removes it, and any later reply returns
 * `404 QuestionNotFoundError`. So when a new-image daemon releases too,
 * whichever lands second is a no-op — reported here as `already_answered`,
 * which callers treat as success.
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
    const url = `${resolved.endpoint.url}/question/${encodeURIComponent(requestId)}/reply?directory=${encodeURIComponent(WORKSPACE)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: sandboxRuntimeRequestHeaders({
        ...resolved.endpoint.headers,
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({ answers }),
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) return 'released';
    if (res.status === 404) return 'already_answered';
    return 'unreachable';
  } catch {
    return 'unreachable';
  }
}
