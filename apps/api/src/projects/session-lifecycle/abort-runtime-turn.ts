import { resolveSessionOpencodeEndpoint } from './engine';
import { sandboxRuntimeRequestHeaders } from '../sandbox-fetch';

const WORKSPACE = '/workspace';

/**
 * Abort whatever turn the runtime still thinks is running for this session.
 *
 * Closing a channel card is not the same as ending the run. On dev
 * 2026-09-19 a Teams turn died mid-flight: the ledger settled it
 * `runtime_gone`, the 30-minute GC eventually closed the Adaptive Card — and
 * OpenCode kept an assistant message OPEN, with `time.created` and no
 * `time.completed`, for two days. Every later message in that conversation was
 * accepted by `prompt_async`, stored, and never run. Two of the user's
 * messages vanished that way with nothing shown to them.
 *
 * `POST /session/:id/abort` is what unwedges it — the same call the Stop
 * button makes. Verified by hand on the stuck session: the open message
 * flipped to `MessageAbortedError` and the conversation accepted prompts
 * again.
 *
 * Best effort by design. The caller is a housekeeping sweep that has already
 * decided the turn is dead; a sandbox that is parked, gone, or simply slow is
 * not a reason to fail the sweep.
 *
 * `requestedStop`: a person pressed Stop (Slack, Teams). This call does not pass
 * the sandbox proxy that stamps `UserStop` on web and CLI stops, so it stamps
 * the open turn itself. Without the stamp the abort reads as a failure nobody
 * explained. A stamp that fails never blocks the stop.
 */
export async function abortRuntimeTurn(
  sessionId: string,
  opts: { requestedStop?: boolean } = {},
): Promise<boolean> {
  if (!sessionId) return false;
  try {
    const resolved = await resolveSessionOpencodeEndpoint(sessionId);
    if (!resolved) return false;
    if (opts.requestedStop) {
      try {
        const { markTurnStopRequested } = await import('../sandbox-turn-lifecycle');
        await markTurnStopRequested(sessionId, 'UserStop', {
          opencodeSessionId: resolved.opencodeSessionId,
        });
      } catch (err) {
        console.warn('[abort-runtime-turn] could not stamp the requested stop', {
          sessionId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const url = `${resolved.endpoint.url}/session/${encodeURIComponent(resolved.opencodeSessionId)}/abort?directory=${encodeURIComponent(WORKSPACE)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: sandboxRuntimeRequestHeaders(resolved.endpoint.headers),
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
