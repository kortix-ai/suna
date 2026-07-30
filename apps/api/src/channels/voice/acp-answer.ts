/**
 * Reading a finished agent turn out of the ACP envelope log, for the voice
 * answer watch.
 *
 * WHY THIS EXISTS. answer-watch.ts used to be 100% OpenCode REST, and under
 * managed ACP that path is structurally dead twice over: `project_sessions`
 * stores the ACP SERVER id in `opencode_session_id`
 * (session-lifecycle/engine.ts:484), so `GET /session/<id>/message` is a
 * guaranteed 404, and the in-sandbox OpenCode REST server is never started at
 * all (kortix-sandbox-agent-server main.ts skips `opencode.start()` for managed
 * ACP). Every ACP voice ask therefore waited out its six-minute deadline in
 * silence. `kortix.acp_session_envelopes` is the ACP source of truth, it is in
 * Postgres, and it survives the sandbox.
 *
 * COMPLETION EVIDENCE, NOT POLLED TEXT. A turn is finished when the harness
 * answers the `session/prompt` request. That response is persisted
 * (session-lifecycle/headless-acp.ts `postEnvelope`) and carries the required
 * `stopReason` — headless-acp.ts:337 throws without one. So terminality is a
 * FACT in the log, not an inference from "the text stopped growing". That
 * matters here more than anywhere else, because every ACP delivery calls
 * `session/load` first (headless-acp.ts:233) and a load makes the harness
 * re-emit the whole finished conversation as fresh `session/update`
 * notifications. Text-shaped detection would read a replay of the PREVIOUS
 * answer as this turn's answer; a prompt-response ordinal cannot.
 *
 * The ordinal of that response envelope is the turn's identity: `ordinal` is
 * monotonic per session, unique, and never clipped by a read window — unlike a
 * position in the folded message list, which shifts as older turns fall out of
 * `limit`.
 *
 * The TEXT still comes from `compactAcpEnvelopes` (shared/compact-transcript.ts),
 * the one tested envelope→message fold this repo has — chunk joining, scope
 * filtering, replay de-duplication and sanitization all live there. A second
 * fold written here would re-earn every bug that one already fixed (a naive fold
 * gives ~11x the text on a real session).
 *
 * It is handed only the completed turn's OWN envelope window — the
 * `session/prompt` request through its response — rather than the whole log.
 * That is what makes "a replay is never read aloud twice" structural instead of
 * a property of the fold: a `session/load` replay of this answer necessarily
 * lands AFTER the response that ended the turn, so it is outside the window and
 * cannot reach the room. The fold's own messageId de-duplication is a
 * best-effort second line (it merges re-emissions but concatenates two
 * back-to-back loads with no prompt between them, which two browser mounts of
 * one session produce), and the room is the wrong place to depend on it.
 */
import type { StoredAcpEnvelope } from '../../projects/lib/acp-transcript';
import { compactAcpEnvelopes } from '../../shared/compact-transcript';

/**
 * Folded-message cap. One turn's window holds the prompt and the reply, so this
 * is generous already; it exists only so a pathological window cannot produce an
 * unbounded list.
 */
const FOLD_LIMIT = 8;

/** A `session/prompt` that the harness has answered — the turn is over. */
export interface AcpTurnCompletion {
  /** Envelope ordinal of the response. Monotonic per session; the turn's id. */
  ordinal: number;
  /** Envelope ordinal of the `session/prompt` request it answers. */
  promptOrdinal: number;
  /** `end_turn`, `max_tokens`, … Null when the prompt failed instead. */
  stopReason: string | null;
  /** The JSON-RPC error the prompt failed with, if it failed. */
  error: string | null;
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The error text of a failed prompt response. Mirrors the OpenCode reader's
 * preference order: a nested `data.message` is where the human-readable cause
 * usually is, `message` is the common case, and the code is the last resort so
 * a failure is never reported as an empty string.
 */
function responseError(body: Record<string, unknown>): string | null {
  if (body.error === undefined || body.error === null) return null;
  const error = asObject(body.error);
  const nested = asObject(error.data).message;
  if (typeof nested === 'string' && nested.trim()) return nested;
  if (typeof error.message === 'string' && error.message.trim()) return error.message;
  if (error.code !== undefined) return `ACP error ${String(error.code)}`;
  return 'unknown error';
}

/**
 * The newest finished turn in the log, or null if no prompt has been answered.
 *
 * A response envelope is only a turn completion when its `id` matches a
 * `session/prompt` REQUEST id and it came FROM the agent. Both halves of that
 * are load-bearing:
 *
 *  - `initialize`, `session/new`, `session/load` and `session/set_config_option`
 *    all get their own responses on the same connection (headless-acp.ts's
 *    `call`), and every one of them lands in this log. Matching on "a response,
 *    any response" would mark the handshake as the answer and speak the previous
 *    turn's text instantly.
 *  - the client answers the agent's `session/request_permission` with the
 *    AGENT's id, written `client_to_agent`. Directional filtering keeps a
 *    permission reply from ever looking like a turn ending.
 *
 * Envelopes arrive ordinal-ascending (`loadAcpTranscript` orders by ordinal), so
 * a request is always seen before its response; the highest matching ordinal is
 * compared explicitly rather than assumed, so an unordered caller degrades to
 * "the newest one" instead of "the last one in the array".
 */
export function latestAcpTurnCompletion(
  envelopes: readonly StoredAcpEnvelope[],
): AcpTurnCompletion | null {
  const promptOrdinals = new Map<string, number>();
  let latest: AcpTurnCompletion | null = null;

  for (const stored of envelopes) {
    const body = stored.envelope;
    if (body.id === undefined || body.id === null) continue;
    const id = String(body.id);

    if (body.method === 'session/prompt') {
      // Overwrite rather than keep the first: `rpcId` starts at `Date.now()`
      // per delivery (headless-acp.ts:161), so two deliveries in the same
      // millisecond would reuse an id. The window then belongs to the newer
      // prompt, which is the one being answered.
      promptOrdinals.set(id, stored.ordinal);
      continue;
    }
    if (typeof body.method === 'string') continue;
    if (stored.direction !== 'agent_to_client') continue;
    const promptOrdinal = promptOrdinals.get(id);
    if (promptOrdinal === undefined) continue;
    if (latest && stored.ordinal <= latest.ordinal) continue;

    const result = asObject(body.result);
    latest = {
      ordinal: stored.ordinal,
      promptOrdinal,
      stopReason: typeof result.stopReason === 'string' ? result.stopReason : null,
      error: responseError(body),
    };
  }

  return latest;
}

/**
 * What to read aloud: the assistant's reply inside `turn`'s own window.
 *
 * Empty is a legitimate answer — a turn can be nothing but tool calls — and the
 * caller reports that as its own outcome rather than speaking silence. Tool
 * output, reasoning and file contents never come out of the fold, so they can
 * never be read into a room.
 */
export function acpSpokenAnswer(
  envelopes: readonly StoredAcpEnvelope[],
  turn: AcpTurnCompletion,
  options: { acpSessionId: string | null; maxChars: number },
): string {
  const window = envelopes.filter(
    (stored) => stored.ordinal >= turn.promptOrdinal && stored.ordinal <= turn.ordinal,
  );
  const messages = compactAcpEnvelopes(window, {
    acpSessionId: options.acpSessionId,
    limit: FOLD_LIMIT,
    maxChars: options.maxChars,
  });
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'assistant') return message.text;
  }
  return '';
}
