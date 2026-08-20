import { log } from "../core/log";

const TRANSIENT_SHAPE =
  /edge-laundered|MAINTENANCE_MODE|status=50[234]|\b50[234]\b|network error|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i;

/**
 * Bounded retry for WORLD-BOOTSTRAP creates only.
 *
 * The ke2e client correctly refuses to replay a non-idempotent POST through an
 * edge-laundered 5xx mid-flow (the origin may have committed). Bootstrap is
 * different: it runs once per shard before any flow, all shards start it at
 * the same instant against a service that may have just rolled, and a single
 * laundered 503 there kills the whole shard via funding fail-fast (observed:
 * run 32327849378, every shard dead in 63s on one 503 each).
 *
 * The caller must make each attempt SAFE to re-issue — e.g. mint the token
 * under a fresh per-attempt name, or re-create a checkout whose abandoned
 * predecessor is inert until confirmed. `attempt` (1-based) is passed in so
 * the caller can do exactly that.
 */
export async function retryBootstrapCreate<T>(
  what: string,
  fn: (attempt: number) => Promise<T>,
  { attempts = 3, baseDelayMs = 5_000 }: { attempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const msg = (err as Error)?.message ?? String(err);
      if (attempt === attempts || !TRANSIENT_SHAPE.test(msg)) throw err;
      log.warn(
        `bootstrap: ${what} attempt ${attempt}/${attempts} hit a transient failure, retrying: ${msg.slice(0, 200)}`,
      );
      await new Promise((r) => setTimeout(r, baseDelayMs * attempt));
    }
  }
  throw lastErr;
}
