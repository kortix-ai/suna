/**
 * Slack turn-error classification — turns an opencode turn failure into honest,
 * human copy for the thread.
 *
 * Before this, a run that died (out of credits, rate-limited, provider auth) was
 * relayed to Slack as a blank "_This run ended without a reply._" or a generic
 * "_The run hit an error._" — so a workspace whose credits ran out looked simply
 * broken, even though the web UI said exactly what happened. This mirrors the web
 * UI's classifier (features/session/session-error-banner.tsx) and goes further:
 * every opencode error type gets specific, non-alarming, actionable copy, and we
 * never dump raw provider jargon (5xx HTML, safety text) into a public thread.
 *
 * Input is the flattened opencode error (AssistantMessage.error / session.error):
 *   { name, message, statusCode, isRetryable, providerID } where `name` is one of
 *   opencode's error names (ProviderAuthError | APIError | MessageAbortedError |
 *   MessageOutputLengthError | UnknownError) and `statusCode` is the upstream HTTP
 *   status for an APIError (402, 429, 401, 5xx, …).
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
  /** `APIError.data.isRetryable` — opencode's own transient/permanent signal. */
  isRetryable?: boolean;
  /** `ProviderAuthError.data.providerID` — names the provider in the copy. */
  providerID?: string;
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

// The conversation outgrew the model's context window. Common, distinct, and
// user-actionable (start a fresh thread / summarize).
function isContextWindow(lower: string): boolean {
  return (
    lower.includes('context length') ||
    lower.includes('context window') ||
    lower.includes('maximum context') ||
    lower.includes('context_length_exceeded') ||
    lower.includes('too many tokens') ||
    lower.includes('prompt is too long') ||
    lower.includes('input is too long')
  );
}

// Model declined on content-policy grounds. Keep the copy neutral and NEVER echo
// the raw safety text — it's alarming in a public channel.
function isContentFilter(lower: string): boolean {
  return (
    lower.includes('content filter') ||
    lower.includes('content_filter') ||
    lower.includes('content policy') ||
    lower.includes('content_policy') ||
    lower.includes('safety') ||
    lower.includes('flagged') ||
    lower.includes('responsible ai') ||
    lower.includes('cannot assist')
  );
}

// Provider auth / config: a bad or expired key, or a model the provider rejects.
// opencode surfaces the same root cause as either ProviderAuthError or an
// APIError 401/403, depending on where it failed — collapse them.
function isProviderConfig(name: string, status: number | undefined): boolean {
  return name === 'ProviderAuthError' || status === 401 || status === 403;
}

// The selected model doesn't exist / isn't enabled for this key — a config fix,
// not an outage. Usually a 404, sometimes phrased in the message.
function isModelNotFound(status: number | undefined, lower: string): boolean {
  if (
    lower.includes('model not found') ||
    lower.includes('no such model') ||
    lower.includes('unknown model') ||
    lower.includes('does not exist') ||
    lower.includes('is not a valid model')
  ) {
    return true;
  }
  return status === 404 && lower.includes('model');
}

// Transient provider/network trouble — a temporary upstream error or a dropped
// connection. Prefer opencode's own isRetryable flag; fall back to the HTTP
// status and, for socket errors (which carry no status), the message text.
function isTransient(status: number | undefined, isRetryable: boolean | undefined, lower: string): boolean {
  if (isRetryable === true) return true;
  if (status === 408 || (typeof status === 'number' && status >= 500 && status <= 599)) return true;
  return (
    lower.includes('fetch failed') ||
    lower.includes('etimedout') ||
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('enotfound') ||
    lower.includes('socket hang up') ||
    lower.includes('network error') ||
    lower.includes('service unavailable') ||
    lower.includes('bad gateway') ||
    lower.includes('gateway timeout') ||
    lower.includes('internal server error')
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
 *
 * Ordering is specific → general: the cheap, conclusive cases (abort, credits,
 * usage limit) win first; content-policy and context-window are caught before
 * the provider-config / transient buckets so their distinct copy isn't shadowed.
 */
export function classifyTurnError(info?: TurnErrorInfo): ClassifiedTurnError {
  const name = (info?.name ?? '').trim();
  const message = (info?.message ?? '').trim();
  const status = info?.statusCode;
  const isRetryable = info?.isRetryable;
  const providerID = (info?.providerID ?? '').trim();
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

  // 4. Output hit the model's max length — the reply was cut off, not "no reply".
  //    (opencode's MessageOutputLengthError carries no message.)
  if (name === 'MessageOutputLengthError' || lower.includes('output length') || lower.includes('max_tokens')) {
    return {
      title: 'Response too long',
      text:
        `:scroll: *The response hit the model's maximum length and was cut off.*` +
        ` Ask me to continue, or narrow the request so the answer fits.`,
      aborted: false,
    };
  }

  // 5. Content-policy refusal — neutral copy, never echo the raw safety text.
  if (isContentFilter(lower)) {
    return {
      title: 'Request blocked',
      text:
        `:no_entry: *The model declined to answer this request on content-policy grounds.*` +
        ` Try rephrasing it.`,
      aborted: false,
    };
  }

  // 6. Conversation outgrew the context window.
  if (isContextWindow(lower)) {
    return {
      title: 'Conversation too long',
      text:
        `:books: *This conversation got too long for the model's context window.*` +
        ` Start a fresh thread (or ask me to summarize) and continue from there.`,
      aborted: false,
    };
  }

  // 7. Model doesn't exist / isn't enabled — a config fix.
  if (isModelNotFound(status, lower)) {
    return {
      title: 'Model unavailable',
      text:
        `:warning: *The selected model isn't available.*` +
        ` Pick a different model in Kortix settings, then mention me again.`,
      aborted: false,
    };
  }

  // 8. Provider auth / config — bad or expired key, billing not set up.
  if (isProviderConfig(name, status)) {
    const who = providerID ? `the ${providerID} provider` : 'the model provider';
    return {
      title: 'Provider rejected the request',
      text:
        `:warning: *${capitalize(who)} rejected this request* — its API key or model config in Kortix` +
        ` may be invalid or expired. Ask a workspace admin to check the provider settings, then mention me again.`,
      aborted: false,
    };
  }

  // 9. Transient provider/network trouble — temporary, retry guidance, no raw body.
  if (isTransient(status, isRetryable, lower)) {
    return {
      title: 'Provider unavailable',
      text:
        `:warning: *The model provider had a temporary problem, so the run couldn't finish.*` +
        ` It usually clears in a moment — mention me again to retry.`,
      aborted: false,
    };
  }

  // 10. Anything else — never hide it. Show the real error when we have one;
  //     otherwise an honest "unexpected error" (the session footer carries the
  //     link to dig in). Name-tag a detail-less error for debuggability.
  if (message) {
    return { title: 'Run failed', text: `:warning: *Run failed* — ${truncate(message, 400)}`, aborted: false };
  }
  const named = name ? ` (${name})` : '';
  return {
    title: 'Run failed',
    text: `:warning: *The run hit an unexpected error and couldn't finish.*${named} Open the session for details.`,
    aborted: false,
  };
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}
