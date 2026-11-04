/**
 * Plan usage of a subscription account (a ChatGPT or Claude login), read from
 * the provider's response headers. Every response of both providers names how
 * much of each plan window is used:
 *
 *   - ChatGPT: `x-codex-{primary,secondary}-used-percent` (0–100),
 *     `-window-minutes`, `-reset-at` (epoch seconds) or `-reset-after-seconds`.
 *   - Claude: `anthropic-ratelimit-unified-{5h,7d,…}-utilization` (0–1),
 *     `-reset` (epoch seconds), and `anthropic-ratelimit-unified-status`
 *     (`rejected` while the account is limited).
 *
 * The gateway reports the snapshot to the host, which stores it on the account
 * so the account list can show it. Nothing here reads a body or a token.
 */

export interface SubscriptionUsageWindow {
  /** `five_hour`, `weekly`, or the provider's own window name (`7d_opus`). */
  id: string;
  /** The window length in minutes: 300 for five hours, 10080 for a week. Null when unknown. */
  window_minutes: number | null;
  /** The share of the window's allowance used, 0–100. */
  used_percent: number;
  /** When the window resets, ISO 8601. Null when the provider did not say. */
  resets_at: string | null;
}

export interface SubscriptionUsage {
  windows: SubscriptionUsageWindow[];
  /** The provider refuses this account's requests now. */
  limited: boolean;
  observed_at: string;
  /** `response`: a model call's headers. `usage_endpoint`: the provider's usage API. */
  source: 'response' | 'usage_endpoint';
}

const FIVE_HOURS = 300;
const WEEK = 7 * 24 * 60;

function finite(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function percent(value: number): number {
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
}

/** The window's name from its length: the two windows both providers use get stable ids. */
export function windowId(minutes: number | null, fallback: string): string {
  if (minutes === FIVE_HOURS) return 'five_hour';
  if (minutes === WEEK) return 'weekly';
  return fallback;
}

/**
 * The instant `Date` can represent, else null. The provider's header is untrusted
 * input: a reset past year 275760 is no reset time, never a throw out of a read
 * that runs after the answer was already served.
 */
function representable(milliseconds: number): Date | null {
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date;
}

function epochIso(seconds: number | null): string | null {
  return seconds !== null && seconds > 0 ? representable(seconds * 1000)?.toISOString() ?? null : null;
}

function afterIso(seconds: number | null, now: number): string | null {
  return seconds !== null ? representable(now + seconds * 1000)?.toISOString() ?? null : null;
}

function codexWindows(headers: Headers, now: number): SubscriptionUsageWindow[] {
  const windows: SubscriptionUsageWindow[] = [];
  for (const slot of ['primary', 'secondary']) {
    const used = finite(headers.get(`x-codex-${slot}-used-percent`));
    if (used === null) continue;
    const minutes = finite(headers.get(`x-codex-${slot}-window-minutes`));
    const resetAt = finite(headers.get(`x-codex-${slot}-reset-at`));
    const resetAfter = finite(headers.get(`x-codex-${slot}-reset-after-seconds`));
    windows.push({
      id: windowId(minutes, slot),
      window_minutes: minutes,
      used_percent: percent(used),
      resets_at: resetAt !== null ? epochIso(resetAt) : resetAfter !== null ? afterIso(resetAfter, now) : null,
    });
  }
  return windows;
}

const CLAUDE_WINDOW_MINUTES: Record<string, number> = { '5h': FIVE_HOURS, '7d': WEEK };
const CLAUDE_UTILIZATION = /^anthropic-ratelimit-unified-([a-z0-9_]+)-utilization$/;

function claudeWindows(headers: Headers): SubscriptionUsageWindow[] {
  const windows: SubscriptionUsageWindow[] = [];
  headers.forEach((value, key) => {
    const name = CLAUDE_UTILIZATION.exec(key)?.[1];
    const used = name ? finite(value) : null;
    if (!name || used === null) return;
    const minutes = CLAUDE_WINDOW_MINUTES[name] ?? null;
    windows.push({
      id: windowId(minutes, name),
      window_minutes: minutes,
      used_percent: percent(used * 100),
      resets_at: epochIso(finite(headers.get(`anthropic-ratelimit-unified-${name}-reset`))),
    });
  });
  // Shortest window first; the provider's header order is not a contract.
  return windows.sort((a, b) => (a.window_minutes ?? Infinity) - (b.window_minutes ?? Infinity));
}

/** The plan usage a ChatGPT or Claude response reports, or null when it reports none. */
export function subscriptionUsageFromHeaders(headers: Headers, now = Date.now()): SubscriptionUsage | null {
  const codex = codexWindows(headers, now);
  const windows = codex.length ? codex : claudeWindows(headers);
  if (!windows.length) return null;
  const rejected = headers.get('anthropic-ratelimit-unified-status') === 'rejected';
  return {
    windows,
    limited: rejected || windows.some((window) => window.used_percent >= 100),
    observed_at: new Date(now).toISOString(),
    source: 'response',
  };
}

/** A snapshot equal to the last one sent is re-sent at most once a minute. */
const RESEND_MS = 60_000;

function changed(a: SubscriptionUsage, b: SubscriptionUsage): boolean {
  if (a.limited !== b.limited || a.windows.length !== b.windows.length) return true;
  return a.windows.some((window, index) => {
    const other = b.windows[index]!;
    return window.id !== other.id || Math.abs(window.used_percent - other.used_percent) >= 1;
  });
}

/**
 * A fire-and-forget reporter for one gateway replica: every model response
 * calls it, and it sends a snapshot only when a window moved by a whole
 * percent, the limit state changed, or a minute passed. A failed send is logged
 * and never reaches the model response.
 */
export function createUsageReporter<Context>(
  send: (context: Context, secretId: string, usage: SubscriptionUsage) => Promise<void>,
  options: { now?: () => number; logger?: Pick<Console, 'warn'> } = {},
): (context: Context, secretId: string, usage: SubscriptionUsage) => void {
  const now = options.now ?? Date.now;
  const logger = options.logger ?? console;
  // replica-local: the last snapshot sent per account, only to skip repeats.
  const last = new Map<string, { at: number; usage: SubscriptionUsage }>();
  return (context, secretId, usage) => {
    const previous = last.get(secretId);
    const at = now();
    if (previous && at - previous.at < RESEND_MS && !changed(previous.usage, usage)) return;
    last.set(secretId, { at, usage });
    if (last.size > 10_000) last.delete(last.keys().next().value!);
    send(context, secretId, usage).catch((error) => {
      logger.warn('[gateway] could not record subscription usage', { secretId, error: error instanceof Error ? error.message : String(error) });
    });
  };
}
