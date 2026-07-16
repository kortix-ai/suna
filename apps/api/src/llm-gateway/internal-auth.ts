import { timingSafeEqual } from 'node:crypto';

const MIN_INTERNAL_TOKEN_LENGTH = 24;
const KNOWN_WEAK_TOKENS = new Set([
  'test',
  'secret',
  'changeme',
  'change-me',
  'password',
  'internal',
  'token',
  'default',
]);

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

/**
 * Cheap defense-in-depth for the API↔standalone-gateway-pod control plane,
 * which is otherwise a single shared static bearer token (see
 * RELIABILITY-BACKLOG.md item 7b — full mutual auth (mTLS/HMAC) is an
 * infra-level change, tracked there). This does not reject a weak token —
 * only a real mTLS/HMAC upgrade should ever do that, and this repo has no
 * mechanism to safely block a running deployment from serving traffic — it
 * just surfaces a loud, cheap boot-time signal so a trivial/default/guessable
 * `GATEWAY_INTERNAL_TOKEN` doesn't sit unnoticed in a production config.
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
        `GATEWAY_INTERNAL_TOKEN entry is only ${token.length} chars (want >= ${MIN_INTERNAL_TOKEN_LENGTH}) — a short static bearer token is brute-forceable.`,
      );
      continue;
    }
    if (KNOWN_WEAK_TOKENS.has(token.toLowerCase())) {
      warnings.push(
        'GATEWAY_INTERNAL_TOKEN entry matches a known-weak/default value — rotate it to a random secret.',
      );
    }
  }
  return warnings;
}
