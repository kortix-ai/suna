import { timingSafeEqual } from 'node:crypto';

const MIN_INTERNAL_TOKEN_LENGTH = 24;

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
  // A short token is brute-forceable: it never matches (weakInternalTokenWarnings
  // logs why at boot).
  const accepted = tokensCsv
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length >= MIN_INTERNAL_TOKEN_LENGTH);

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

/**
 * Boot-time reasons a configured `GATEWAY_INTERNAL_TOKEN` entry is refused.
 * The API↔standalone-gateway control plane is a shared static bearer token
 * (plus the edge key where set), so an entry under 24 chars never matches —
 * this names it in the log instead of failing silently with 401s.
 */
export function weakInternalTokenWarnings(tokensCsv: string | undefined): string[] {
  if (!tokensCsv) return [];
  const tokens = tokensCsv
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  const warnings: string[] = [];
  for (const token of tokens) {
    if (token.length < MIN_INTERNAL_TOKEN_LENGTH) {
      warnings.push(
        `GATEWAY_INTERNAL_TOKEN entry is only ${token.length} chars (want >= ${MIN_INTERNAL_TOKEN_LENGTH}) — it is refused: a short static bearer token is brute-forceable.`,
      );
    }
  }
  return warnings;
}
