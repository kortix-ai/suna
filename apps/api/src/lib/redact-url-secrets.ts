/**
 * Query parameters whose value is a credential, kept out of every log line
 * and error report. An Artifact's live socket authenticates with `?ticket=`
 * (KRTX-3669): a browser cannot set `Authorization` on a WebSocket. The ticket
 * is sealed and single-use, and it still must not sit in log storage. The same
 * holds for the bearer material other routes accept in a query: the preview
 * terminal's `?token=`, OAuth-style `access_token` / `refresh_token`, and the
 * one-shot `public_share` token.
 */
const SECRET_NAMES = ['ticket', 'token', 'access_token', 'refresh_token', 'public_share'] as const;
const SECRET_PARAMS = new Set<string>(SECRET_NAMES);
const SECRET_QUERY = new RegExp(`(^|[?&])(${SECRET_NAMES.join('|')})=[^&#\\s"']*`, 'gi');
const REDACTED = '<redacted>';
const MAX_DEPTH = 8;

/** `…?ticket=abc&x=1` → `…?ticket=<redacted>&x=1`. Any other text is unchanged. */
export function redactUrlSecrets(text: string): string {
  return text.replace(SECRET_QUERY, (_match, lead: string, name: string) => `${lead}${name}=${REDACTED}`);
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function scrub(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return redactUrlSecrets(value);
  if (value === null || typeof value !== 'object' || depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    // A parsed query string as `[name, value]` pairs.
    if (value.length === 2 && typeof value[0] === 'string' && SECRET_PARAMS.has(value[0].toLowerCase())) return [value[0], REDACTED];
    return value.map((item) => scrub(item, depth + 1));
  }
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SECRET_PARAMS.has(key.toLowerCase()) && typeof item === 'string' ? REDACTED : scrub(item, depth + 1);
  }
  return out;
}

/**
 * A Sentry event or transaction with every ticket value replaced: the request
 * URL, its `query_string` (a string, an object or pairs), the transaction name,
 * span attributes and breadcrumbs.
 */
export function redactSentryRequestSecrets<T>(event: T): T {
  return scrub(event, 0) as T;
}
