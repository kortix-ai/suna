// Shared extraction of the REAL human-readable message + code from an upstream
// error body, used by BOTH the non-streaming failover path (parseUpstreamBody
// there already inlined a simpler version of this) and the streaming SSE path
// (transports/ai-sdk/sse.ts), so an upstream's actual rejection reason — e.g.
// "context length exceeded from messages" — reaches the caller instead of being
// buried under a generic HTTP status text like "Bad Request".
//
// Why this exists: the AI SDK (`@ai-sdk/provider-utils`'s
// `createJsonErrorResponseHandler`) wraps a non-2xx upstream response in an
// `APICallError` whose `.message` is the upstream's `error.message` ONLY when
// the body parses against the provider's error schema; if it doesn't (a
// non-OpenAI-shaped error, an HTML error page, a plain string, ...) the
// `.message` falls back to `response.statusText` ("Bad Request", "Internal
// Server Error", ...) — generic and useless. The actionable text then lives
// ONLY in `.responseBody` (raw) / `.data` (parsed when the schema matched).
// Without mining those, the gateway forwards the generic message and (for the
// streaming path) classifies it as a blanket 502 "Bad Gateway" — the live
// defect this module fixes (2026-08-01: upstream 400 surfaced as "Bad
// Gateway" instead of "context length exceeded from messages").

/** Result of mining an upstream error body for the real message + code. */
export interface UpstreamErrorDetail {
  /** The most specific human-readable message we could extract. */
  message: string;
  /** The upstream's own error code/type if one is present (string or number). */
  code?: string | number;
}

const CONTEXT_OVERFLOW_PATTERNS = [
  /context length (?:is )?exceeded/i,
  /exceeds? (?:the )?context window/i,
  /maximum context length is \d+ tokens[\s\S]*\brequested\b/i,
  /prompt is too long/i,
  /input is too long/i,
  /(?:input|prompt)[\s\S]*exceeds?[\s\S]*context (?:limit|window)/i,
];

/**
 * Convert provider-specific context overflow responses into the one semantic
 * code OpenAI-compatible clients use. Some providers return only HTTP 400 (or
 * `invalid_request_error`) and put the actual classification in the message.
 */
export function normalizeUpstreamErrorCode(
  code: string | number | undefined,
  message: string,
): string | number | undefined {
  if (code === 'context_length_exceeded') return code;
  if (CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(message))) {
    return 'context_length_exceeded';
  }
  return code;
}

/**
 * Mine a PARSED upstream error object (the shape `{error:{message,code,type,
 * param}}` OpenAI-compatible upstreams use, the Anthropic shape
 * `{type:"error",error:{type,message}}`, or a top-level `{message,code}`) for
 * the real message + code. Returns `{message}` with `code` only when a real
 * one is present — never throws.
 */
export function extractUpstreamErrorDetail(parsed: unknown): UpstreamErrorDetail | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const root = parsed as Record<string, unknown>;

  // OpenAI-compatible: `{error:{message,type,param,code}}`.
  const nestedError = root.error;
  if (nestedError && typeof nestedError === 'object') {
    const err = nestedError as Record<string, unknown>;
    const message = typeof err.message === 'string' ? err.message : undefined;
    if (message && message.length > 0) {
      const code =
        typeof err.code === 'string' || typeof err.code === 'number'
          ? err.code
          : typeof err.type === 'string' && err.type.length > 0
            ? err.type
            : undefined;
      const normalizedCode = normalizeUpstreamErrorCode(code, message);
      return { message, ...(normalizedCode !== undefined ? { code: normalizedCode } : {}) };
    }
  }

  // Top-level `{message, code}` / `{message, type}`.
  const message = typeof root.message === 'string' ? root.message : undefined;
  if (message && message.length > 0) {
    const code =
      typeof root.code === 'string' || typeof root.code === 'number'
        ? root.code
        : typeof root.type === 'string' && root.type.length > 0
          ? root.type
          : undefined;
    const normalizedCode = normalizeUpstreamErrorCode(code, message);
    return { message, ...(normalizedCode !== undefined ? { code: normalizedCode } : {}) };
  }

  return null;
}

/**
 * Parse a raw upstream response BODY string for the real message + code.
 * Mirrors `extractUpstreamErrorDetail` over the JSON-parsed body; falls back to
 * the raw body text itself only when it is non-empty (an HTML/plain error page
 * is still more useful than a generic status text), and to `fallback` when the
 * body is empty. Never throws.
 */
export function parseUpstreamErrorBody(body: string, fallback = 'Upstream request failed'): UpstreamErrorDetail {
  if (!body || !body.trim()) return { message: fallback };
  try {
    const parsed = JSON.parse(body);
    const detail = extractUpstreamErrorDetail(parsed);
    if (detail) return detail;
  } catch {
    // Not JSON — the raw body (an HTML error page, a plain string) is the most
    // specific message we have; trim a potentially huge body so it never blows
    // up a client-facing error.
    return { message: body.length > 2000 ? `${body.slice(0, 2000)}…` : body };
  }
  return { message: body.length > 2000 ? `${body.slice(0, 2000)}…` : body };
}

/**
 * The HTTP status text the AI SDK falls back to when an upstream body fails its
 * error-schema parse — these are the generic messages that should be REPLACED
 * by a real message mined from the body/data whenever one is available. Keened
 * lowercase + trimmed for case-insensitive `startsWith` matching, and bounded
 * to short phrases so a genuine upstream message that happens to start with
 * "bad request:" (with a colon) is NOT mistaken for a status text.
 */
const GENERIC_STATUS_TEXTS = new Set([
  'bad request',
  'forbidden',
  'unauthorized',
  'not found',
  'internal server error',
  'bad gateway',
  'service unavailable',
  'gateway timeout',
  'request timeout',
  'too many requests',
  'conflict',
  'unprocessable entity',
  'payment required',
]);

/**
 * True when `message` is a generic HTTP status text the AI SDK uses as a
 * last-resort `.message` (e.g. "Bad Request") — i.e. NOT the upstream's real
 * rejection reason. Used to decide whether to replace it with a message mined
 * from `responseBody`/`data`.
 */
export function isGenericStatusText(message: string | undefined | null): boolean {
  if (!message) return false;
  return GENERIC_STATUS_TEXTS.has(message.trim().toLowerCase());
}
