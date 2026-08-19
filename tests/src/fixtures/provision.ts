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
let active = 0;
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
 * Provision a project via /v1/projects/provision.
 *
 * The retry policy accepts only transient network failures, HTTP 5xx responses,
 * and explicit rate-limit responses. Other HTTP 4xx responses fail immediately.
 */
export async function provisionProject(
  client: Client,
  body: Record<string, unknown>,
): Promise<string> {
  await acquire();
  try {
    let lastFailure = '';
    let attempts = 0;
    for (let attempt = 0; attempt < MAX_PROVISION_ATTEMPTS; attempt++) {
      attempts = attempt + 1;
      let r: Awaited<ReturnType<Client['post']>>;
      try {
        await paceProvisionRequest();
        r = await client.post('/v1/projects/provision', body, {
          timeoutMs: PROVISION_REQUEST_TIMEOUT_MS,
        });
      } catch (error) {
        if (!isKe2eRetryableError(error) || attempt === MAX_PROVISION_ATTEMPTS - 1) {
          throw error;
        }
        await sleep(retryDelayMs(attempt, false));
        continue;
      }

      const id = r.json<{ project_id?: unknown }>()?.project_id;
      if (typeof id === 'string' && id.length > 0) return id;
      const responseText = r.text();
      lastFailure = `HTTP ${r.statusCode}: ${responseText}`;
      const rateLimited = RATE_LIMIT_RE.test(responseText);
      const retryable = isRetryableProvisionStatus(r.statusCode) || rateLimited;
      if (!retryable || attempt === MAX_PROVISION_ATTEMPTS - 1) break;
      await sleep(retryDelayMs(attempt, rateLimited));
    }
    throw new Error(
      `project provision returned no id after ${attempts} attempt(s): ${lastFailure}`,
    );
  } finally {
    release();
  }
}
