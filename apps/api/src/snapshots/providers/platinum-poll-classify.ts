/**
 * Classify errors seen while polling Platinum for a just-registered template
 * (PHASE 2 POLLING ERRORS + RETRY CONTROL).
 *
 * The old `waitForActive` swallowed EVERY lookup error into `null` → treated as
 * `state: 'missing'` → looped to the deadline → threw a generic
 * "did not become ready (last state: missing)". That misclassified a dead API
 * key (401/403) and a TLS failure as "not visible yet" and burned the whole
 * poll window on them. This module distinguishes:
 *
 *   auth-permanent      401/403 — dead/revoked key; fail NOW.
 *   not-visible         404 — the row lags its own id; keep polling (healthy).
 *   rate-limited        429 — transient; back off, honor Retry-After.
 *   transient-5xx       5xx — transient; back off + retry.
 *   transient-transport DNS / socket reset / timeout; back off + retry.
 *   security-terminal   TLS/cert/hostname mismatch; fail NOW (never silently
 *                       keep talking to a wrong/insecure endpoint).
 *   unknown             anything else; bounded retry, not an instant failure.
 *
 * Native transport failures are recognized by walking `Error.cause` for the
 * approved codes — a `fetch` TypeError wraps the real cause several levels deep.
 */

export type PollErrorClass =
  | 'auth-permanent'
  | 'not-visible'
  | 'rate-limited'
  | 'transient-5xx'
  | 'transient-transport'
  | 'security-terminal'
  | 'unknown';

/** Native socket/DNS codes that are transient and worth a bounded retry. */
export const TRANSIENT_TRANSPORT_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/** TLS/certificate/hostname failures are terminal — a wrong or insecure
 *  endpoint must never be retried into. */
export const SECURITY_TERMINAL_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'HOSTNAME_MISMATCH',
  'CERT_UNTRUSTED',
]);

/**
 * Walk the `Error.cause` chain collecting `.code` / `.name` strings. A native
 * fetch failure surfaces as `TypeError: fetch failed` whose `.cause` (an
 * AggregateError or a system error) holds the real `code`.
 */
export function walkErrorCauseCodes(err: unknown, max = 8): string[] {
  const codes: string[] = [];
  let cur: unknown = err;
  const seen = new Set<unknown>();
  for (let i = 0; i < max && cur && typeof cur === 'object' && !seen.has(cur); i++) {
    seen.add(cur);
    const e = cur as { code?: unknown; name?: unknown; cause?: unknown; errors?: unknown };
    if (typeof e.code === 'string') codes.push(e.code);
    if (typeof e.name === 'string') codes.push(e.name);
    // AggregateError (Undici surfaces connect failures this way).
    if (Array.isArray(e.errors)) {
      for (const sub of e.errors) codes.push(...walkErrorCauseCodes(sub, 3));
    }
    cur = e.cause;
  }
  return codes;
}

/** HTTP status parsed from a `platinum <method> <path> -> <status> <body>` message. */
export function httpStatusFromMessage(msg: string): number | undefined {
  const m = msg.match(/->\s*(\d{3})\b/);
  return m ? Number(m[1]) : undefined;
}

/**
 * Retry-After (ms) if the error carries one. `platinumJson` appends
 * `retry-after=<seconds>` to a 429 message when the response header is present;
 * we also accept an HTTP-date is NOT parsed here (seconds only) — a missing or
 * unparseable value returns undefined and the caller uses its backoff default.
 */
export function retryAfterMsFromError(err: unknown): number | undefined {
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/retry-after=(\d+)/i);
  if (!m) return undefined;
  const secs = Number(m[1]);
  return Number.isFinite(secs) && secs >= 0 ? secs * 1000 : undefined;
}

export function classifyPlatinumPollError(err: unknown): PollErrorClass {
  const codes = walkErrorCauseCodes(err);
  if (codes.some((c) => SECURITY_TERMINAL_CODES.has(c))) return 'security-terminal';

  const msg = err instanceof Error ? err.message : String(err);
  const status = httpStatusFromMessage(msg);
  if (status === 401 || status === 403) return 'auth-permanent';
  if (status === 404) return 'not-visible';
  if (status === 429) return 'rate-limited';
  if (status !== undefined && status >= 500 && status <= 599) return 'transient-5xx';

  if (codes.some((c) => TRANSIENT_TRANSPORT_CODES.has(c))) return 'transient-transport';
  // Our own AbortSignal.timeout / undici timeout surface by name, not code.
  if (codes.includes('AbortError') || codes.includes('TimeoutError')) return 'transient-transport';
  if (/timed out|timeout/i.test(msg)) return 'transient-transport';

  return 'unknown';
}

/** A poll error that must fail the wait immediately (no more polling). */
export function isTerminalPollError(cls: PollErrorClass): boolean {
  return cls === 'auth-permanent' || cls === 'security-terminal';
}
