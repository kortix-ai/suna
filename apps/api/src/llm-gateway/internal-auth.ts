import type { Effect } from 'effect';
import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time check of the internal control-plane bearer token.
 *
 * `tokensCsv` may be a comma-separated list so the token can be rotated without
 * downtime: issue the new one alongside the old, deploy, then retire the old.
 * Comparison is timing-safe and length-guarded.
 */
export function matchesInternalToken(
  authHeader: string | undefined,
  tokensCsv: string | undefined,
): boolean {
  if (!tokensCsv) return false;
  const provided = authHeader?.match(/^Bearer\s+(\S.*)$/i)?.[1]?.trim();
  if (!provided) return false;

  const providedBuf = Buffer.from(provided);
  const accepted = tokensCsv
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  let ok = false;
  for (const token of accepted) {
    const tokenBuf = Buffer.from(token);
    // timingSafeEqual throws on a length mismatch, so guard length first. Keep
    // scanning the whole list rather than early-returning to avoid leaking which
    // token matched through timing.
    if (tokenBuf.length === providedBuf.length && timingSafeEqual(tokenBuf, providedBuf)) {
      ok = true;
    }
  }
  return ok;
}
