/**
 * Slack turn-error classification — turns an opencode turn failure into honest,
 * human copy for the thread.
 *
 * Before this, a run that died (out of credits, rate-limited, provider auth) was
 * relayed to Slack as a blank "_This run ended without a reply._" or a generic
 * "_The run hit an error._" — so a workspace whose credits ran out looked simply
 * broken, even though the web UI said exactly what happened. This mirrors the web
 * UI's classifier (features/session/session-error-banner.tsx) so Slack and the
 * dashboard tell the same story.
 *
 * Input is the flattened opencode error (AssistantMessage.error / session.error):
 *   { name, message, statusCode } where `name` is one of opencode's error names
 *   (ProviderAuthError | APIError | MessageAbortedError | UnknownError | …) and
 *   `statusCode` is the upstream HTTP status for an APIError (402, 429, …).
 *
 * Pure + dependency-free so it's unit-tested in isolation (no Slack, no DB).
 */

/** Flattened opencode error detail relayed from the sandbox. */
export interface TurnErrorInfo {
  /** opencode error name, e.g. `APIError` / `ProviderAuthError` / `MessageAbortedError`. */
  name?: string;
  /** Human message from `error.data.message`. */
  message?: string;
  /** Upstream HTTP status for an `APIError` (e.g. 402 = credits, 429 = rate limit). */
  statusCode?: number;
}

export interface ClassifiedTurnError {
  /** Plan-block title for the finalized turn ("Out of credits", "Run failed", …). */
  title: string;
  /** Slack mrkdwn body for the thread. No session link — the finalizer adds the footer. */
  text: string;
  /** True for a user-initiated stop — render lowkey (no alarming failure copy). */
  aborted: boolean;
}

// User-initiated stops (matches session-error-banner.tsx ABORT_PATTERNS). These
// aren't failures — don't paint them red.
const ABORT_PATTERNS = ['operation was aborted', 'aborted', 'abort', 'cancelled', 'canceled'];

function isAbort(name: string, lower: string): boolean {
  if (name === 'MessageAbortedError') return true;
  return ABORT_PATTERNS.some((p) => lower.includes(p));
}

// Upstream 402 from the LLM gateway: "Payment Required: Insufficient credits.
// Balance: $-0.06". The gateway is the only thing that can 402 us, so a bare 402
// is conclusive even without the text.
function isInsufficientCredits(status: number | undefined, lower: string): boolean {
  if (status === 402) return true;
  return (
    lower.includes('insufficient credits') ||
    (lower.includes('payment required') && lower.includes('credit')) ||
    (lower.includes('402') && lower.includes('credit'))
  );
}

// Provider throttling or a plan cap — opencode retries these, so by the time the
// turn ends with one it genuinely couldn't finish.
function isUsageLimit(status: number | undefined, lower: string): boolean {
  if (status === 429) return true;
  return (
    lower.includes('usage limit') ||
    lower.includes('rate limit') ||
    lower.includes('rate-limit') ||
    lower.includes('too many requests')
  );
}

/** Pull a "$-0.06"-style balance out of the gateway's credits error, if present. */
export function parseBalance(text: string): string | null {
  const match = text.match(/balance:\s*\$?(-?\d+(?:\.\d+)?)/i);
  if (!match) return null;
  const value = parseFloat(match[1]!);
  if (Number.isNaN(value)) return null;
  return `$${value.toFixed(2)}`;
}

function truncate(s: string, max: number): string {
  const trimmed = s.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Classify a turn error into the copy Slack should show. Always returns a
 * result — an unknown error surfaces its real message rather than a blank
 * "ended without a reply", so a run is never silently "just broken".
 */
export function classifyTurnError(info?: TurnErrorInfo): ClassifiedTurnError {
  const name = (info?.name ?? '').trim();
  const message = (info?.message ?? '').trim();
  const status = info?.statusCode;
  const lower = message.toLowerCase();

  // 1. User stopped the run (or a follow-up superseded it) — quiet, not a failure.
  if (isAbort(name, lower)) {
    return { title: 'Run stopped', text: '_Run stopped._', aborted: true };
  }

  // 2. Out of credits — the single most common "looks broken but isn't" case.
  if (isInsufficientCredits(status, lower)) {
    const balance = parseBalance(message);
    const tail = balance ? ` Current balance: *${balance}*.` : '';
    return {
      title: 'Out of credits',
      text:
        `:credit_card: *This workspace is out of credits, so the agent can't reply here.*${tail}` +
        ` Top up credits (or turn on auto top-up) in Kortix and mention me again to continue.`,
      aborted: false,
    };
  }

  // 3. Usage / rate limit — provider throttling or a plan cap.
  if (isUsageLimit(status, lower)) {
    return {
      title: 'Usage limit reached',
      text:
        `:hourglass_flowing_sand: *Usage limit reached* — the model provider is rate-limiting this workspace,` +
        ` so the run couldn't finish. Give it a minute, then mention me again.`,
      aborted: false,
    };
  }

  // 4. Provider auth / config — key rejected, model unavailable, billing not set up.
  if (name === 'ProviderAuthError') {
    const detail = message ? ` ${truncate(message, 280)}` : '';
    return {
      title: 'Run failed',
      text: `:warning: *The model provider rejected the request.*${detail}`.trimEnd(),
      aborted: false,
    };
  }

  // 5. Anything else — never hide it. Show the real error so it's debuggable.
  const detail = message ? truncate(message, 400) : 'The run hit an error before it could reply.';
  return { title: 'Run failed', text: `:warning: *Run failed* — ${detail}`, aborted: false };
}
