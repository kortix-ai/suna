/**
 * Error-message unwrapping — extracted from turns/index.ts so it can be
 * shared with classify.ts (classifyTurn's TurnError normalization) without
 * creating an index.ts <-> classify.ts import cycle.
 */

/**
 * Extract human-readable error message from a raw error value.
 * Matches SolidJS `unwrap()` function — session-turn.tsx:34-81
 */
export function unwrapError(raw: unknown): string {
  if (!raw) return 'An error occurred';

  if (typeof raw === 'string') {
    // Strip "Error: " prefix
    let str = raw.startsWith('Error: ') ? raw.slice(7) : raw;

    // Try JSON parsing (might be double-encoded)
    try {
      const parsed = JSON.parse(str);
      if (typeof parsed === 'string') {
        str = parsed; // double-encoded string
        try {
          const inner = JSON.parse(str);
          return extractErrorFromObject(inner) || str;
        } catch {
          return str;
        }
      }
      return extractErrorFromObject(parsed) || str;
    } catch {
      // Not directly parseable as JSON — router/executor errors commonly wrap
      // a JSON body inside a plain-text prefix, e.g. router tool credit
      // failures: `Error: 402 Error: {"error":true,"message":"Insufficient
      // credits","status":402}`. Extract the outermost {...} substring (if
      // any) and try that instead of surfacing the raw prefixed string.
      const embedded = extractEmbeddedJsonMessage(str);
      return embedded ?? str;
    }
  }

  // (`!raw` at the top already excluded null — typeof alone suffices here.)
  if (typeof raw === 'object') {
    return extractErrorFromObject(raw) || 'An error occurred';
  }

  return String(raw);
}

/**
 * Best-effort substring spanning the first `{` to the last `}` in a larger
 * non-JSON string — correct for the common single-object case (nested
 * double-wrapped errors don't nest braces inside the outer text). Shared by
 * `extractEmbeddedJsonMessage` (message-only) and `extractGatewayErrorDetails`
 * (full structured envelope) below.
 */
function embeddedJsonSubstring(str: string): string | undefined {
  const start = str.indexOf('{');
  const end = str.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return undefined;
  return str.slice(start, end + 1);
}

/**
 * Best-effort extraction of a human message from a JSON object embedded
 * somewhere inside a larger non-JSON string. Cheap; falls back to `undefined`
 * (never throws) if that substring isn't valid JSON or has no recognizable
 * error shape.
 */
function extractEmbeddedJsonMessage(str: string): string | undefined {
  const substring = embeddedJsonSubstring(str);
  if (!substring) return undefined;
  try {
    return extractErrorFromObject(JSON.parse(substring));
  } catch {
    return undefined;
  }
}

function extractErrorFromObject(obj: unknown): string | undefined {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return undefined;
  // Try common error shapes
  const record = obj as Record<string, unknown>;
  if (typeof record.message === 'string' && record.message) return record.message;
  if (typeof record.error === 'string' && record.error) return record.error;
  const data = record.data as { message?: unknown } | undefined | null;
  if (typeof data?.message === 'string') return data.message;
  const error = record.error as { message?: unknown } | undefined | null;
  if (typeof error?.message === 'string') return error.message;
  return undefined;
}

// ============================================================================
// GatewayErrorDetails — surfacing the LLM gateway's structured error envelope
// ============================================================================
//
// `gatewayErrorBody()` (packages/llm-gateway/src/pipeline/error-response.ts)
// computes `provider`, `code`, `upstream_status`, `suggestion`, and
// `request_id` for every gateway error — but until now nothing on the client
// read past `.message`: a BYOK auth failure, a rate limit, and an unroutable
// model all rendered as an identical bare string with no way to tell which
// provider/model was involved or what to actually do about it. This section
// recovers those fields, best-effort, from whatever shape the error takes by
// the time it reaches a host — the SAME raw value `unwrapError` above already
// handles, so both can run over it without either needing to know about the
// other's shape assumptions.

/** The gateway's structured error fields, when recoverable from a raw error
 *  value. All fields but `message` are optional — a plain, non-gateway error
 *  (or a gateway error whose enrichment genuinely didn't apply, e.g. a
 *  pre-dispatch 401 with no resolved provider yet) simply omits them. */
export interface GatewayErrorDetails {
  message: string;
  provider?: string;
  code?: string;
  suggestion?: string;
  upstreamStatus?: number;
  requestId?: string;
}

function tryParseJson(value: unknown): unknown {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** Pull the gateway envelope's fields off a single object level (no
 *  unwrapping of nested shapes — that's `extractGatewayErrorDetails`'s job).
 *  Returns `undefined` when NONE of the gateway-specific fields are present,
 *  so a plain `{message}` object never synthesizes a details record with
 *  nothing but a message (that's already `unwrapError`'s / `extractErrorFromObject`'s
 *  job, and callers use `GatewayErrorDetails`'s absence to fall back to it). */
function gatewayFieldsFrom(obj: Record<string, unknown>): GatewayErrorDetails | undefined {
  const provider = typeof obj.provider === 'string' && obj.provider ? obj.provider : undefined;
  const code = typeof obj.code === 'string' && obj.code ? obj.code : undefined;
  const suggestion = typeof obj.suggestion === 'string' && obj.suggestion ? obj.suggestion : undefined;
  const upstreamStatus = typeof obj.upstream_status === 'number' ? obj.upstream_status : undefined;
  const requestId = typeof obj.request_id === 'string' && obj.request_id ? obj.request_id : undefined;
  if (!provider && !code && !suggestion && upstreamStatus === undefined && !requestId) return undefined;
  const message = (typeof obj.message === 'string' && obj.message) || extractErrorFromObject(obj) || '';
  return { message, provider, code, suggestion, upstreamStatus, requestId };
}

/**
 * Best-effort extraction of the gateway's rich structured error fields from
 * whatever shape a thrown/wrapped error takes by the time it reaches a host.
 * Returns `undefined` when nothing gateway-specific is recoverable (a plain
 * error/message with no gateway envelope at all) — callers should fall back
 * to `unwrapError`'s plain message in that case.
 *
 * Shapes checked, in order:
 *  1. The gateway body directly — top-level fields, or nested under `.error`
 *     (both shapes `gatewayErrorBody()` emits, kept for whichever field-level
 *     reader a client happens to use).
 *  2. opencode's turn-level `ApiError` (`{name:'APIError', data:{responseBody}}`)
 *     — `responseBody` is the raw upstream response TEXT the AI SDK captured,
 *     which for our own gateway IS the JSON string `gatewayErrorBody()`
 *     produced, so it survives even though opencode's own typed error shape
 *     only otherwise exposes `data.message`.
 *  3. `@opencode-ai/sdk`'s client-error wrapper (`new Error(msg, {cause:
 *     {body}})`) — recurse into `cause.body`.
 *  4. A JSON (or JSON-embedded-in-text) string.
 */
export function extractGatewayErrorDetails(raw: unknown): GatewayErrorDetails | undefined {
  if (raw == null) return undefined;

  if (typeof raw === 'string') {
    const str = raw.startsWith('Error: ') ? raw.slice(7) : raw;
    const parsed = tryParseJson(str) ?? tryParseJson(embeddedJsonSubstring(str));
    return parsed !== undefined ? extractGatewayErrorDetails(parsed) : undefined;
  }

  if (typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;

  const direct = gatewayFieldsFrom(record);
  if (direct) return direct;

  const errorField = record.error;
  if (errorField && typeof errorField === 'object' && !Array.isArray(errorField)) {
    const nested = gatewayFieldsFrom(errorField as Record<string, unknown>);
    if (nested) return nested;
  }

  const data = record.data as Record<string, unknown> | undefined;
  if (data && typeof data.responseBody === 'string') {
    const parsedBody = tryParseJson(data.responseBody);
    if (parsedBody !== undefined) {
      const fromBody = extractGatewayErrorDetails(parsedBody);
      if (fromBody) return fromBody;
    }
  }

  const cause = record.cause;
  if (cause && typeof cause === 'object') {
    const causeBody = (cause as Record<string, unknown>).body;
    if (causeBody !== undefined) {
      const fromCause = extractGatewayErrorDetails(causeBody);
      if (fromCause) return fromCause;
    }
  }

  return undefined;
}
