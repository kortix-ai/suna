import type { OpenCodeConfig as Config } from './config';
import { logger } from '@/lib/log/logger';
import type { Opencode } from './lifecycle';
import type { OpencodeTurnError } from './events';

// ─────────────────────────────────────────────────────────────────────────────
// Turn-level auto-resume: when a ROOT turn dies from a TRANSIENT provider/stream
// failure (a stalled model host killed mid-stream — "Upstream idle timeout
// exceeded" — a connection reset, a 5xx after opencode's own retries), the turn
// is re-prompted to continue instead of surfacing a dead red turn to the user.
//
// WHY here and not lower in the stack: the gateway cannot replay a stream whose
// bytes were already relayed (a fresh sample would splice two different
// generations). The agent server is the platform-owned layer that already
// watches `session.error` and owns the session lifecycle — the only place a
// turn can be resumed with full context.
//
// THIS RUNS ON TOP OF UPSTREAM RETRIES — verified against the real binaries
// 2026-08-20 (`SessionRetry` module, symbols read out of both bundles):
//   1.17.11 — `retryable()` returns a retry only for an `APIError` with
//     `isRetryable === true` or `statusCode >= 500`. No attempt cap constant.
//     The comment this replaces ("opencode does not retry an error that arrives
//     mid-stream") was written against THIS build and was true for it.
//   1.18.19 — same `APIError` gate, but the retried class is much broader: the
//     message AND `responseBody` are matched against six regexes covering
//     `429|500|502|503|504|524`, rate limits, `overloaded|service
//     unavailable|internal server error`, `terminated|fetch failed|network
//     error|connection error|socket hang up|econnreset|etimedout|getaddrinfo`,
//     request/stream timeouts, and `try your request again|resource exhausted`.
//     `RETRY_MAX_RETRIES = 5`, `RETRY_INITIAL_DELAY = 2000ms`,
//     `RETRY_BACKOFF_FACTOR = 2`, jitter 0.25, capped at 30s without a
//     `retry-after` header.
// So on 1.18.19 most of `TRANSIENT_MESSAGE` below OVERLAPS upstream's list, and
// a turn that reaches `session.error` has usually already burned ~5 upstream
// attempts (~60s) before this module adds up to 3 more re-prompts (5s/15s/45s).
// That is intentional layering, not a bug — upstream retries the same model
// call, this re-prompts the turn — but it is a real multiplier on time-to-fail,
// so shortening MAX_ATTEMPTS_PER_WINDOW is the first lever if a turn ever looks
// like it is retrying "forever". Errors that are NOT `APIError` instances are
// still not retried by either opencode build; those reach here on the first
// failure.
//
// LOOP SAFETY: a failed turn can end in `session.idle` as well as
// `session.error`, so resetting a counter on idle would re-arm the budget on
// every failure and retry forever. The budget is a rolling window instead:
// at most MAX_ATTEMPTS resumes per session per WINDOW_MS, with growing backoff,
// regardless of how the intervening turns ended. Exhausted budget → the error
// relays/surfaces exactly as before this feature.
//
// T22 — STAGED REVERT: OpenCode's `session.revert` is a pointer on the session
// row (`Session.revert?: { messageID, ... }`); nothing is deleted until the
// NEXT prompt — from ANY producer — commits the truncation. Resuming a turn
// while a revert is staged would deliver this resumer's own recovery prompt
// with full pre-rewind context, silently committing the user's rewind out
// from under them. `maybeResume` checks the session's live revert state both
// before starting (the error may already have a revert staged) and again at
// fire time after the backoff (a revert can be staged DURING the wait) — see
// `readSessionRevertState`. Either hit stands auto-recovery down for that
// error; the caller relays it exactly as before this feature.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_ATTEMPTS_PER_WINDOW = 3;
const WINDOW_MS = 15 * 60_000;
// 5s, 15s, 45s — long enough for a wedged upstream host to be rotated out,
// short enough that a demo/user barely notices the hiccup.
const BACKOFF_MS = [5_000, 15_000, 45_000];

/** Kill switch: KORTIX_TURN_AUTO_RESUME=0 restores the old fail-fast behavior. */
function enabled(): boolean {
  return (process.env.KORTIX_TURN_AUTO_RESUME ?? '1').trim() !== '0';
}

// Errors that must NEVER be auto-resumed: the user aborted on purpose, or the
// failure needs a human/config fix (auth, credits, malformed request).
const PERMANENT_ERROR_NAMES = new Set(['MessageAbortedError', 'ProviderAuthError']);

// Message shapes of transient infrastructure failures seen from providers —
// matched only after the permanent names/statuses above are excluded. Includes
// OpenRouter's mid-stream "Upstream idle timeout exceeded" (the exact prod
// failure this feature exists for), which arrives as an UnknownError whose
// message is sometimes JSON-quoted.
//
// `stream ended (without|before)` covers an upstream stream cut before its
// terminal frame. A factory worker turn ended with "Stream ended without
// finish_reason" and was never resumed, so its sandbox idled and stopped.
// Verbatim variants in shipped bundles: "Stream ended without finish_reason",
// "<Provider> stream ended without a finish reason / a stop reason",
// "... stream ended before message_stop / a terminal response event"
// (@earendil-works/pi-ai 0.85.1, whose own utils/retry.js retries "ended
// without"); "OpenAI Chat stream ended without finish_reason" (OpenCode
// 2.0.15, classification `incomplete-stream`); "SSE stream ended without a
// data event"; "The model stream ended without a finish chunk" (ai 7.x
// NoOutputGeneratedError). `other side closed` is undici's SocketError text
// for a peer that closed the socket mid-response.
//
// A stream cut mid data-line surfaces as a JSON parse error of the partial
// chunk ("JSON parsing failed: Text: {\"id\":\"chatcmpl…", "JSON Parse error:
// Unable to parse JSON string"). A gateway availability error reads "<model>
// is temporarily unavailable"; Bun's fetch timeout reads "The operation timed
// out". All four were prod turn-enders with no resume.
const TRANSIENT_MESSAGE =
  /upstream idle timeout|connection (reset|closed|error)|econnreset|econnrefused|etimedout|socket hang ?up|fetch failed|premature close|network error|overloaded|empty completion|upstream_stream_error|internal server error|bad gateway|service unavailable|temporarily unavailable|gateway.?time.?out|timed out|stream (closed|error|disconnected)|stream ended (without|before)|other side closed|terminated|json pars(e|ing)|unable to parse json/i;

/** Is this turn failure a transient provider/stream error worth one more try? */
export function isTransientTurnError(error?: OpencodeTurnError): boolean {
  if (!error) return false;
  if (error.name && PERMANENT_ERROR_NAMES.has(error.name)) return false;
  const status = error.statusCode;
  if (typeof status === 'number') {
    if (status === 408 || status === 429 || status >= 500) return true;
    // Remaining 4xx (auth, credits, bad request, not found) are the caller's to
    // fix — a retry would fail identically and burn budget.
    if (status >= 400) return false;
  }
  if (error.isRetryable === true) return true;
  return typeof error.message === 'string' && TRANSIENT_MESSAGE.test(error.message);
}

/** Trim + de-JSON-quote an upstream error message for embedding in the resume prompt. */
function describeError(error: OpencodeTurnError): string {
  let msg = (error.message ?? error.name ?? 'unknown provider error').trim();
  // OpenRouter error frames arrive with the message JSON-quoted ("\"...\"").
  if (msg.startsWith('"') && msg.endsWith('"') && msg.length > 1) msg = msg.slice(1, -1);
  return msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
}

// ── KRTX-1746: name the interrupted subagent in the resume prompt ───────────
//
// When a root turn dies while a `task` (subagent) call was in flight, the bare
// resume prompt's "re-run it if it did not complete" makes the model re-send
// the SAME prompt to a NEW subagent — the failed child's work is lost and the
// failure looks unrecoverable. The child session survives (OpenCode keeps a
// failed child; its id rides the part's `state.metadata.sessionId`, or the
// `task_id:` sentence in `state.error` when the task tool failed), so the
// resume prompt names it and tells the model to resume THAT subagent via the
// task tool's `task_id` parameter instead of re-dispatching.
//
// Shapes verified against opencode 1.18.23 with a mock provider (2026-10-07):
// a failed task part ends `status: 'error'` with `state.error =
// "Subagent failed (task_id: <childId>): …"` and `state.metadata` retained; a
// turn cut mid-task leaves the part `running` with the same metadata.
export interface InterruptedSubagent {
  /** The child session id — the task tool's `task_id` resume parameter. */
  taskId: string;
  /** The dispatch's `description` (or first prompt line), for the prompt text. */
  description?: string;
  /** The failed task tool's error text, so the model sees WHY it failed. */
  error?: string;
  /** `true` — the task tool failed; `false` — the turn died with it running. */
  failed: boolean;
}

/** Row shape of opencode's `GET /session/{id}/message`. */
export interface MessageRows
  extends Array<{
    info?: { role?: string; error?: unknown; time?: { completed?: number } };
    parts?: unknown;
  }> {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const SESSION_ID_IN_ERROR = /\btask_id:\s*(ses_[A-Za-z0-9]+)/;

/**
 * Pure: the subagent dispatches the errored turn left behind, from the last
 * assistant message's parts. Only the `task` tool's calls count — its child
 * sessions are the ones the task tool itself can resume via `task_id`; the
 * legacy delegate twins (agent_spawn, session_spawn, …) spawn worker sessions
 * no task tool can resume. Dispatches that finished (`completed`) are not
 * interrupted and are skipped.
 */
export function interruptedSubagents(rows: MessageRows): InterruptedSubagent[] {
  const last = rows[rows.length - 1];
  if (!last || last.info?.role !== 'assistant' || !Array.isArray(last.parts)) return [];
  const found: InterruptedSubagent[] = [];
  for (const raw of last.parts) {
    if (!isRecord(raw) || raw.type !== 'tool' || raw.tool !== 'task') continue;
    const state = isRecord(raw.state) ? raw.state : undefined;
    const status = typeof state?.status === 'string' ? state.status : '';
    if (status !== 'error' && status !== 'running' && status !== 'pending') continue;
    const metadata = isRecord(state?.metadata) ? state.metadata : undefined;
    const metaSessionId = typeof metadata?.sessionId === 'string' ? metadata.sessionId : undefined;
    const errorText = typeof state?.error === 'string' ? state.error : undefined;
    const errorSessionId = errorText ? (errorText.match(SESSION_ID_IN_ERROR)?.[1] ?? undefined) : undefined;
    const taskId = metaSessionId ?? errorSessionId;
    if (!taskId) continue;
    const input = isRecord(state?.input) ? state.input : undefined;
    const descriptionInput = typeof input?.description === 'string' ? input.description : undefined;
    const promptInput = typeof input?.prompt === 'string' ? input.prompt : undefined;
    const description = (descriptionInput ?? promptInput?.split('\n')[0]?.trim() ?? undefined)?.slice(0, 80) || undefined;
    found.push({
      taskId,
      description,
      error: errorText ? errorText.slice(0, 160) : undefined,
      failed: status === 'error',
    });
  }
  return found;
}

function resumePrompt(error: OpencodeTurnError, subagents: readonly InterruptedSubagent[]): string {
  const base =
    `[auto-recovery] Your previous response was interrupted by a transient provider error (${describeError(error)}). ` +
    'Resume the task from where it stopped: check which step or tool call was cut off, re-run it if it did not complete, ' +
    'and continue to the original goal. Do not redo work that already succeeded.';
  if (subagents.length === 0) return base;
  // A turn in flight rarely has more than a couple of live dispatches; cap the
  // list so a pathological transcript cannot balloon the resume prompt.
  const lines = subagents
    .slice(0, 3)
    .map((task) => {
      const fate = task.failed
        ? `the task tool failed: ${task.error ?? 'unknown error'}`
        : 'the task tool never returned';
      return `- "${task.description ?? 'a dispatched subagent'}" — subagent session ${task.taskId} (${fate})`;
    })
    .join('\n');
  return (
    `${base}\n\nThe interruption hit while a subagent call was in flight, so the subagent did not finish:\n${lines}\n` +
    'Resume THAT subagent instead of starting a new one: call the task tool again passing its task_id to continue it with its context intact. ' +
    'Start a fresh subagent only if resuming that one fails.'
  );
}

/**
 * The prompt for a turn the runtime itself aborted before it reached the model
 * (see instance-guard.ts). Nothing ran, so there is nothing to check or redo.
 */
const RUNTIME_FAULT_PROMPT =
  '[auto-recovery] The runtime stopped your previous turn before it started, because of an internal fault that ' +
  'is now repaired. Nothing from that turn ran. Answer the request above.';

/** The instance is healed before a runtime-fault resume; wait only briefly. */
const RUNTIME_FAULT_BACKOFF_MS = 500;

export interface MaybeResumeOptions {
  /**
   * `runtime-fault`: the turn aborted before it reached the model while nobody
   * asked for a stop, and the instance was healed (instance-guard.ts). Resumed
   * although `MessageAbortedError` is otherwise never resumed.
   */
  cause?: 'runtime-fault';
}

export interface TurnAutoResumerDeps {
  opencode: Pick<Opencode, 'getInternalUrl'>;
  cfg: Pick<Config, 'workspace'>;
  /** Root check — subagent (Task tool) failures are the parent model's to handle. */
  isRoot: (opencodeSessionId: string) => Promise<boolean>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface TurnAutoResumer {
  /**
   * Try to auto-resume an errored turn. Resolves true when a resume prompt was
   * delivered (or the session verifiably moved on by itself) — the caller must
   * then NOT relay the error as the turn's final outcome. Resolves false when
   * the error is not resumable (permanent error, subagent session, budget
   * exhausted, resume delivery failed) — the caller relays it exactly as before.
   */
  maybeResume(opencodeSessionId: string, error?: OpencodeTurnError, opts?: MaybeResumeOptions): Promise<boolean>;
}

interface LastMessageView {
  role?: string;
  hasError: boolean;
  completed: boolean;
  /** Subagent dispatches the errored turn left behind (KRTX-1746). */
  subagents: InterruptedSubagent[];
}

export function createTurnAutoResumer(deps: TurnAutoResumerDeps): TurnAutoResumer {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  // Per-session resume timestamps within the rolling window.
  const attempts = new Map<string, number[]>();

  function takeBudget(sessionId: string): number | null {
    const cutoff = now() - WINDOW_MS;
    const stamps = (attempts.get(sessionId) ?? []).filter((t) => t >= cutoff);
    if (stamps.length >= MAX_ATTEMPTS_PER_WINDOW) {
      attempts.set(sessionId, stamps);
      return null;
    }
    const attemptIndex = stamps.length;
    stamps.push(now());
    attempts.set(sessionId, stamps);
    return attemptIndex;
  }

  async function readLastMessage(sessionId: string): Promise<LastMessageView | null> {
    try {
      const url = `${deps.opencode.getInternalUrl()}/session/${encodeURIComponent(sessionId)}/message?directory=${encodeURIComponent(deps.cfg.workspace)}`;
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) return null;
      const rows = (await res.json()) as MessageRows;
      if (!Array.isArray(rows) || rows.length === 0) return null;
      const info = rows[rows.length - 1]?.info;
      return {
        role: info?.role,
        hasError: Boolean(info?.error),
        completed: Boolean(info?.time?.completed),
        subagents: interruptedSubagents(rows),
      };
    } catch {
      return null;
    }
  }

  /**
   * T22 — read whether the session has a STAGED OpenCode revert
   * (`Session.revert?: { messageID, ... }`, `@opencode-ai/sdk` `types.gen`).
   * Reuses the exact daemon pattern `readLastMessage` above already follows —
   * `GET /session/{id}` on the same internal opencode URL, same `directory`
   * query param, same bounded timeout — just the bare session shape instead
   * of `/message`, since that's where `revert` lives. Fails OPEN (returns
   * null) on any read failure: an unreachable/timed-out check must never
   * itself block a legitimate resume.
   */
  async function readSessionRevertState(sessionId: string): Promise<{ staged: boolean } | null> {
    try {
      const url = `${deps.opencode.getInternalUrl()}/session/${encodeURIComponent(sessionId)}?directory=${encodeURIComponent(deps.cfg.workspace)}`;
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) return null;
      const info = (await res.json()) as { revert?: unknown } | null;
      return { staged: Boolean(info?.revert) };
    } catch {
      return null;
    }
  }

  async function deliverResume(sessionId: string, text: string): Promise<boolean> {
    try {
      const url = `${deps.opencode.getInternalUrl()}/session/${encodeURIComponent(sessionId)}/prompt_async?directory=${encodeURIComponent(deps.cfg.workspace)}`;
      // No `model` — the session continues on whatever model it was already using.
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parts: [{ type: 'text', text }] }),
        signal: AbortSignal.timeout(15_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async function maybeResume(
    sessionId: string,
    error?: OpencodeTurnError,
    opts: MaybeResumeOptions = {},
  ): Promise<boolean> {
    if (!enabled()) return false;
    const runtimeFault = opts.cause === 'runtime-fault';
    if (!error || (!runtimeFault && !isTransientTurnError(error))) return false;
    if (!(await deps.isRoot(sessionId))) return false;

    // T22: the error may already have a staged revert sitting on it — the
    // user rewound history before (or right as) this turn failed. Stand down
    // before spending resume budget; the caller relays the error exactly as
    // before this feature.
    const preResumeRevert = await readSessionRevertState(sessionId);
    if (preResumeRevert?.staged) {
      logger.info('[turn-auto-resume] session has a staged revert — standing down', { sessionId });
      return false;
    }

    const attemptIndex = takeBudget(sessionId);
    if (attemptIndex === null) {
      logger.warn('[turn-auto-resume] budget exhausted — surfacing error', {
        sessionId,
        maxAttempts: MAX_ATTEMPTS_PER_WINDOW,
        windowMs: WINDOW_MS,
        errorName: error.name,
      });
      return false;
    }

    const backoffMs = runtimeFault
      ? RUNTIME_FAULT_BACKOFF_MS
      : (BACKOFF_MS[Math.min(attemptIndex, BACKOFF_MS.length - 1)] ?? 5_000);
    logger.info('[turn-auto-resume] turn error — resuming after backoff', {
      sessionId,
      cause: runtimeFault ? 'runtime-fault' : 'transient',
      attempt: attemptIndex + 1,
      backoffMs,
      errorName: error.name,
      errorMessage: describeError(error),
    });
    await sleep(backoffMs);

    // Re-check the session AFTER the backoff: only deliver the resume prompt if
    // the errored assistant message is still the latest thing that happened. If
    // the user (or a parallel flow) already prompted again, or a new turn is
    // running, the session moved on — deliver nothing, and report true so the
    // stale error isn't relayed as the turn's final outcome.
    const last = await readLastMessage(sessionId);
    if (!last) {
      logger.warn('[turn-auto-resume] could not inspect session — surfacing error', { sessionId });
      return false;
    }
    if (!(last.role === 'assistant' && last.hasError)) {
      logger.info('[turn-auto-resume] session moved on during backoff — skipping resume', {
        sessionId,
        lastRole: last.role,
      });
      return true;
    }

    // T22: re-check for a revert staged DURING the backoff wait — the
    // pre-resume check above only ruled it out at the moment the error first
    // arrived. Cheap: same request shape as the pre-check, one more round
    // trip right before the prompt that would otherwise commit the rewind.
    const fireTimeRevert = await readSessionRevertState(sessionId);
    if (fireTimeRevert?.staged) {
      logger.info(
        '[turn-auto-resume] session gained a staged revert during backoff — standing down',
        { sessionId },
      );
      return false;
    }

    const delivered = await deliverResume(
      sessionId,
      runtimeFault ? RUNTIME_FAULT_PROMPT : resumePrompt(error, last.subagents),
    );
    if (!delivered) {
      logger.warn('[turn-auto-resume] resume prompt delivery failed — surfacing error', {
        sessionId,
      });
      return false;
    }
    logger.info('[turn-auto-resume] resume prompt delivered', {
      sessionId,
      attempt: attemptIndex + 1,
    });
    return true;
  }

  return { maybeResume };
}
