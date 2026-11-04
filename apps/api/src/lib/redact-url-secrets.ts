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
/** Any `name=value` pair of a query: the decoded name decides, not its spelling. */
const QUERY_PAIR = /(^|[?&])([^=&#\s"'?]+)=[^&#\s"']*/g;
const REDACTED = '<redacted>';
const MAX_DEPTH = 8;

/**
 * True when a query parameter name, as the server reads it, is a credential.
 * The name is decoded the way `URLSearchParams` decodes it (`+` is a space,
 * then percent escapes) and case-folded, so `%74icket` and `TICKET` count; a
 * malformed escape is not a credential name.
 */
export function isSecretQueryParam(name: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(name.replace(/\+/g, ' '));
  } catch {
    return false;
  }
  return SECRET_PARAMS.has(decoded.toLowerCase());
}

/** `…?ticket=abc&x=1` → `…?ticket=<redacted>&x=1`, for every spelling of a credential name. Any other text is unchanged. */
export function redactUrlSecrets(text: string): string {
  return text.replace(QUERY_PAIR, (match, lead: string, name: string) => (isSecretQueryParam(name) ? `${lead}${name}=${REDACTED}` : match));
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
    if (value.length === 2 && typeof value[0] === 'string' && isSecretQueryParam(value[0])) return [value[0], REDACTED];
    return value.map((item) => scrub(item, depth + 1));
  }
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSecretQueryParam(key) && typeof item === 'string' ? REDACTED : scrub(item, depth + 1);
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
