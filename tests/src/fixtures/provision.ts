/**
 * Project provisioning throttle. Each provision creates a REAL managed GitHub
 * repo; firing many concurrently trips GitHub's secondary rate limit (403). So we
 * cap concurrent provisions with a semaphore and retry on rate-limit with backoff.
 * Everything else in the suite stays fully parallel.
 */
import { type Client, isKe2eRetryableError } from '../core/client';
import { sleep } from '../core/poll';

/**
 * Global cap on concurrent project provisions (KE2E_PROVISION_CONCURRENCY).
 *
 * This — not KE2E_API_WORKERS — was the binding constraint on suite
 * parallelism: most flows start by provisioning, so 2 concurrent provisions
 * held measured speedup at 1.43x with 6 flow workers. 4 doubles the ceiling.
 * The next constraint is GitHub's SECONDARY rate limit on repo creation, which
 * is why raising this is paired with a jittered backoff below: 4 provisions
 * that hit a 403 together must not retry in lockstep.
 */
const MAX = Number(process.env.KE2E_PROVISION_CONCURRENCY ?? 4);
const MIN_REQUEST_INTERVAL_MS = Number(process.env.KE2E_PROVISION_MIN_INTERVAL_MS ?? 0);
/** Ceiling for a rate-limited retry (KE2E_PROVISION_RATE_LIMIT_DELAY_MS). */
const RATE_LIMIT_DELAY_MS = Number(process.env.KE2E_PROVISION_RATE_LIMIT_DELAY_MS ?? 120_000);
/** First rate-limited retry delay; doubles per attempt up to the ceiling. */
const RATE_LIMIT_BASE_DELAY_MS = Number(
  process.env.KE2E_PROVISION_RATE_LIMIT_BASE_DELAY_MS ?? 15_000,
);
/**
 * Total time a provision may spend waiting out rate limits
 * (KE2E_PROVISION_RATE_LIMIT_BUDGET_MS). GitHub's secondary rate limit on
 * repository creation blocked a preview for > 4 min on 2026-09-22; a
 * 5-attempt count ran out first.
 */
const RATE_LIMIT_BUDGET_MS = Number(process.env.KE2E_PROVISION_RATE_LIMIT_BUDGET_MS ?? 15 * 60_000);
/** Longest single wait a server-sent Retry-After may impose. */
const MAX_RETRY_AFTER_MS = 5 * 60_000;
let active = 0;
/**
 * Process-wide cooldown. One provision told to wait by GitHub means every
 * provision is blocked: the limit is per credential, not per request. Firing
 * the others anyway extends GitHub's block.
 */
let rateLimitedUntil = 0;
const waiters: Array<() => void> = [];
let nextRequestAt = 0;
let pacingTail: Promise<void> = Promise.resolve();

async function acquire(): Promise<void> {
  if (active < MAX) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  active++;
}
function release(): void {
  active--;
  waiters.shift()?.();
}

const RATE_LIMIT_RE = /rate limit|secondary rate|temporarily blocked|abuse/i;
const PROVISION_REQUEST_TIMEOUT_MS = 180_000;
const MAX_PROVISION_ATTEMPTS = 5;

function isRetryableProvisionStatus(status: number): boolean {
  return status >= 500 && status <= 599;
}

/**
 * Exponential backoff with equal jitter for a failed provision.
 *
 * Rate-limited retries were a FIXED 120s, so 5 attempts spent up to 8 minutes
 * holding a semaphore slot even when GitHub's block cleared in seconds. They
 * now start at 15s and double to the 120s ceiling. Both paths carry equal
 * jitter (half fixed, half random) so concurrent provisions that trip the same
 * secondary rate limit do not retry in lockstep and re-trip it. Equal jitter,
 * not full jitter: a near-zero retry against a secondary rate limit extends
 * the block instead of clearing it.
 */
export function retryDelayMs(
  attempt: number,
  rateLimited: boolean,
  random: () => number = Math.random,
): number {
  const ceiling = rateLimited
    ? Math.min(RATE_LIMIT_BASE_DELAY_MS * 2 ** attempt, RATE_LIMIT_DELAY_MS)
    : Math.min(5_000 * 2 ** attempt, 30_000);
  const half = ceiling / 2;
  return Math.round(half + random() * half);
}

export async function paceProvisionRequest(
  minimumIntervalMs = MIN_REQUEST_INTERVAL_MS,
): Promise<void> {
  if (minimumIntervalMs <= 0) return;
  const scheduled = pacingTail.then(async () => {
    const delayMs = Math.max(0, nextRequestAt - Date.now());
    if (delayMs > 0) await sleep(delayMs);
    nextRequestAt = Date.now() + minimumIntervalMs;
  });
  pacingTail = scheduled.catch(() => undefined);
  await scheduled;
}

/**
 * The wait a rate-limited response asks for, in ms, or null when it names none.
 * Reads the standard `Retry-After` header (seconds or an HTTP date), then the
 * API's `retry_after_seconds` body field. Capped at MAX_RETRY_AFTER_MS.
 */
export function serverRetryAfterMs(
  r: { header?: (name: string) => string | undefined; json<T>(): T },
  now: number = Date.now(),
): number | null {
  const raw = r.header?.('retry-after')?.trim();
  let ms: number | null = null;
  if (raw) {
    if (/^\d+$/.test(raw)) ms = Number(raw) * 1000;
    else {
      const at = Date.parse(raw);
      if (Number.isFinite(at)) ms = Math.max(0, at - now);
    }
  }
  if (ms === null) {
    const seconds = (() => {
      try {
        return r.json<{ retry_after_seconds?: unknown }>()?.retry_after_seconds;
      } catch {
        return undefined;
      }
    })();
    if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) ms = seconds * 1000;
  }
  return ms === null ? null : Math.min(ms, MAX_RETRY_AFTER_MS);
}

async function awaitRateLimitCooldown(): Promise<void> {
  // Loop: another provision can extend the cooldown while this one sleeps.
  while (rateLimitedUntil > Date.now()) await sleep(rateLimitedUntil - Date.now());
}

/**
 * Provision a project via /v1/projects/provision.
 *
 * The retry policy accepts only transient network failures, HTTP 5xx responses,
 * and explicit rate-limit responses. Other HTTP 4xx responses fail immediately.
 *
 * Rate limits are budgeted by TIME (RATE_LIMIT_BUDGET_MS), not by attempt
 * count. The wait honors the server's `Retry-After` (the API passes GitHub's
 * through) plus jitter, and falls back to exponential backoff when absent.
 * Every concurrent provision shares the resulting cooldown.
 */
export async function provisionProject(
  client: Client,
  body: Record<string, unknown>,
): Promise<string> {
  await acquire();
  try {
    let lastFailure = '';
    let attempts = 0;
    let failures = 0;
    let rateLimitAttempts = 0;
    let rateLimitWaitedMs = 0;
    for (;;) {
      attempts += 1;
      let r: Awaited<ReturnType<Client['post']>>;
      try {
        await awaitRateLimitCooldown();
        await paceProvisionRequest();
        r = await client.post('/v1/projects/provision', body, {
          timeoutMs: PROVISION_REQUEST_TIMEOUT_MS,
        });
      } catch (error) {
        failures += 1;
        if (!isKe2eRetryableError(error) || failures >= MAX_PROVISION_ATTEMPTS) {
          throw error;
        }
        await sleep(retryDelayMs(failures - 1, false));
        continue;
      }

      const id = r.json<{ project_id?: unknown }>()?.project_id;
      if (typeof id === 'string' && id.length > 0) return id;
      const responseText = r.text();
      lastFailure = `HTTP ${r.statusCode}: ${responseText}`;
      const rateLimited = r.statusCode === 429 || RATE_LIMIT_RE.test(responseText);
      if (rateLimited) {
        const serverWait = serverRetryAfterMs(r);
        const backoff = retryDelayMs(rateLimitAttempts, true);
        // Server wait plus up to 15 s jitter so blocked provisions do not
        // return in lockstep; the backoff covers a response with no wait.
        const waitMs =
          serverWait === null ? backoff : serverWait + Math.round(Math.random() * 15_000);
        rateLimitAttempts += 1;
        if (rateLimitWaitedMs + waitMs > RATE_LIMIT_BUDGET_MS) break;
        rateLimitWaitedMs += waitMs;
        rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + waitMs);
        continue;
      }
      failures += 1;
      if (!isRetryableProvisionStatus(r.statusCode) || failures >= MAX_PROVISION_ATTEMPTS) break;
      await sleep(retryDelayMs(failures - 1, false));
    }
    throw new Error(
      `project provision returned no id after ${attempts} attempt(s): ${lastFailure}`,
    );
  } finally {
    release();
  }
}
