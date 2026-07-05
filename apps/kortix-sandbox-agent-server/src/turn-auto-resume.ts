import type { Config } from './config';
import { logger } from './logger';
import type { Opencode } from './opencode';
import type { OpencodeTurnError } from './opencode-events';

// ─────────────────────────────────────────────────────────────────────────────
// Turn-level auto-resume: when a ROOT turn dies from a TRANSIENT provider/stream
// failure (a stalled model host killed mid-stream — "Upstream idle timeout
// exceeded" — a connection reset, a 5xx after opencode's own retries), the turn
// is re-prompted to continue instead of surfacing a dead red turn to the user.
//
// WHY here and not lower in the stack: the gateway cannot replay a stream whose
// bytes were already relayed (a fresh sample would splice two different
// generations), and opencode (pinned npm) does not retry an error that arrives
// mid-stream. The agent server is the platform-owned layer that already watches
// `session.error` and owns the session lifecycle — the only place a turn can be
// resumed with full context.
//
// LOOP SAFETY: a failed turn can end in `session.idle` as well as
// `session.error`, so resetting a counter on idle would re-arm the budget on
// every failure and retry forever. The budget is a rolling window instead:
// at most MAX_ATTEMPTS resumes per session per WINDOW_MS, with growing backoff,
// regardless of how the intervening turns ended. Exhausted budget → the error
// relays/surfaces exactly as before this feature.
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
const TRANSIENT_MESSAGE =
  /upstream idle timeout|connection (reset|closed|error)|econnreset|econnrefused|etimedout|socket hang ?up|fetch failed|premature close|network error|overloaded|empty completion|upstream_stream_error|internal server error|bad gateway|service unavailable|gateway.?time.?out|stream (closed|error|disconnected)|terminated/i;

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

function resumePrompt(error: OpencodeTurnError): string {
  return (
    `[auto-recovery] Your previous response was interrupted by a transient provider error (${describeError(error)}). ` +
    'Resume the task from where it stopped: check which step or tool call was cut off, re-run it if it did not complete, ' +
    'and continue to the original goal. Do not redo work that already succeeded.'
  );
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
  maybeResume(opencodeSessionId: string, error?: OpencodeTurnError): Promise<boolean>;
}

interface LastMessageView {
  role?: string;
  hasError: boolean;
  completed: boolean;
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
      const rows = (await res.json()) as Array<{
        info?: { role?: string; error?: unknown; time?: { completed?: number } };
      }>;
      if (!Array.isArray(rows) || rows.length === 0) return null;
      const info = rows[rows.length - 1]?.info;
      return {
        role: info?.role,
        hasError: Boolean(info?.error),
        completed: Boolean(info?.time?.completed),
      };
    } catch {
      return null;
    }
  }

  async function deliverResume(sessionId: string, error: OpencodeTurnError): Promise<boolean> {
    try {
      const url = `${deps.opencode.getInternalUrl()}/session/${encodeURIComponent(sessionId)}/prompt_async?directory=${encodeURIComponent(deps.cfg.workspace)}`;
      // No `model` — the session continues on whatever model it was already using.
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parts: [{ type: 'text', text: resumePrompt(error) }] }),
        signal: AbortSignal.timeout(15_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async function maybeResume(sessionId: string, error?: OpencodeTurnError): Promise<boolean> {
    if (!enabled()) return false;
    if (!error || !isTransientTurnError(error)) return false;
    if (!(await deps.isRoot(sessionId))) return false;

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

    const backoffMs = BACKOFF_MS[Math.min(attemptIndex, BACKOFF_MS.length - 1)] ?? 5_000;
    logger.info('[turn-auto-resume] transient turn error — resuming after backoff', {
      sessionId,
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

    const delivered = await deliverResume(sessionId, error);
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
