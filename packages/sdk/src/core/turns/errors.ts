/**
 * Error-message unwrapping — extracted from turns/index.ts so it can be
 * shared with classify.ts (classifyTurn's TurnError normalization) without
 * creating an index.ts <-> classify.ts import cycle.
 */

const GENERIC_ERROR_MESSAGE = 'An error occurred';

/**
 * How many serialized layers `unwrapError` will peel. Real rows nest two deep
 * (OpenCode `UnknownError.data.message` → a JSON body → its `error.message`);
 * four leaves headroom without letting a pathological body recurse forever.
 */
const MAX_UNWRAP_DEPTH = 4;

/**
 * Body keys that carry the human sentence, in the order providers use them.
 * `message` is OpenAI/Anthropic/our gateway, `error` is the OpenAI-compatible
 * nesting, `detail` is FastAPI, `error_description` is OAuth, `msg` is
 * pydantic, `errors[]` is GraphQL/Google, `data` is OpenCode's own envelope.
 */
const MESSAGE_KEYS = [
  'message',
  'error',
  'detail',
  'error_description',
  'msg',
  'errors',
  'data',
] as const;

/**
 * `"Error: "`, `"AI_APICallError: "`, `"402 Error: "` — the prefixes `String(err)`
 * and the AI SDK's `toString()` bolt on, which stack when a body is re-thrown
 * (`Error: 402 Error: {…}`). Peeled repeatedly, so the caller sees the body.
 */
function stripErrorPrefixes(str: string): string {
  let s = str.trim();
  for (let i = 0; i < MAX_UNWRAP_DEPTH; i++) {
    const next = s.replace(/^(?:\d{3}\s+)?(?:[A-Za-z_$][\w$]*)?Error:\s*/, '').trim();
    if (next === s) break;
    s = next;
  }
  return s;
}

function tryParseJson(value: unknown): unknown {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/**
 * The first `"message": "…"` (or sibling key) inside a JSON-ish string that
 * does NOT parse — an upstream body truncated by a log limit, or a body with
 * trailing garbage. Unescapes the captured literal through `JSON.parse` so
 * `\"` and `\n` come out as characters, not backslashes.
 */
function messageFieldFromJsonish(str: string): string | undefined {
  const match = str.match(/"(?:message|detail|error_description|msg)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!match) return undefined;
  const literal = tryParseJson(`"${match[1]}"`);
  return typeof literal === 'string' && literal.trim() ? literal.trim() : undefined;
}

/**
 * A gateway or CDN error page (`<html><title>502 Bad Gateway</title>…`). The
 * title is the sentence; failing that, the visible text, capped so a whole
 * page never lands in a transcript row.
 */
function textFromHtml(str: string): string | undefined {
  if (!/^\s*<(?:!doctype|html|head|body)\b/i.test(str)) return undefined;
  const title = str.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim();
  if (title) return title;
  const text = str
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, 200) : undefined;
}

/** `overloaded_error` → `Overloaded error`; `rate_limit_exceeded` → `Rate limit exceeded`. */
function humanizeCode(code: string): string {
  const words = code.replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : words;
}

/**
 * `depth` counts DESERIALIZATION layers (a string parsed into a body), not key
 * hops inside one body — `error.error.message` is one layer, not three. Object
 * nesting is bounded separately by `seen`, which also stops a cyclic
 * `Error.cause` chain from recursing.
 */
function unwrapValue(value: unknown, depth: number, seen: WeakSet<object>): string | undefined {
  if (typeof value === 'string') return unwrapString(value, depth, seen);
  if (value && typeof value === 'object') return unwrapObject(value, depth, seen);
  return undefined;
}

function unwrapString(
  raw: string,
  depth: number,
  seen: WeakSet<object> = new WeakSet(),
): string | undefined {
  const str = stripErrorPrefixes(raw);
  if (!str) return undefined;
  if (depth >= MAX_UNWRAP_DEPTH) return str;

  // The whole string is a body (possibly a double-encoded one).
  const parsed = tryParseJson(str);
  if (parsed !== undefined) {
    if (typeof parsed === 'string') return unwrapString(parsed, depth + 1, seen);
    if (parsed && typeof parsed === 'object') return unwrapObject(parsed, depth + 1, seen);
    return String(parsed);
  }

  // A body wrapped in a plain-text prefix the regex above did not know —
  // router/connector errors commonly do this. Extract the outermost {...}.
  const embedded = embeddedJsonSubstring(str);
  if (embedded) {
    const parsedEmbedded = tryParseJson(embedded);
    if (parsedEmbedded && typeof parsedEmbedded === 'object') {
      const fromEmbedded = unwrapObject(parsedEmbedded, depth + 1, seen);
      if (fromEmbedded) return fromEmbedded;
    }
  }

  // JSON-ish but unparseable (truncated, trailing text): pull the sentence.
  if (str.includes('{')) {
    const field = messageFieldFromJsonish(str);
    if (field) return unwrapString(field, depth + 1, seen) ?? field;
  }

  return textFromHtml(str) ?? str;
}

function unwrapObject(
  obj: object,
  depth: number,
  seen: WeakSet<object> = new WeakSet(),
): string | undefined {
  if (depth >= MAX_UNWRAP_DEPTH || seen.has(obj)) return undefined;
  seen.add(obj);
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const fromItem = unwrapValue(item, depth, seen);
      if (fromItem) return fromItem;
    }
    return undefined;
  }
  const record = obj as Record<string, unknown>;
  for (const key of MESSAGE_KEYS) {
    const fromKey = unwrapValue(record[key], depth, seen);
    if (fromKey) return fromKey;
  }
  // No sentence anywhere. A code or a status is still more useful than
  // "An error occurred" — say what the body did say.
  const code = record.type ?? record.code;
  if (typeof code === 'string' && code.trim()) return humanizeCode(code);
  const status = record.status ?? record.statusCode ?? record.upstream_status;
  if (typeof status === 'number' && Number.isFinite(status)) {
    return `Request failed with status ${status}`;
  }
  return undefined;
}

/**
 * Extract the human-readable sentence from a raw error value, however many
 * layers of serialization it arrived in.
 *
 * OpenCode's `UnknownError` stores `String(err)` as `data.message`; when the
 * thrown error's message was an HTTP body, that body reaches the transcript
 * as a JSON string — `{"message":"Provided authentication token is
 * expired.","code":401}` — unless it is unwrapped AGAIN. So every string this
 * function extracts is fed back through the same unwrapping, bounded by
 * `MAX_UNWRAP_DEPTH`, until a plain sentence falls out.
 *
 * Never returns raw JSON, an HTML page, `[object Object]`, or an empty string.
 */
export function unwrapError(raw: unknown): string {
  if (!raw) return GENERIC_ERROR_MESSAGE;
  if (typeof raw === 'string') return unwrapString(raw, 0) ?? GENERIC_ERROR_MESSAGE;
  if (typeof raw === 'object') return unwrapObject(raw, 0) ?? GENERIC_ERROR_MESSAGE;
  return String(raw);
}

/**
 * Best-effort substring spanning the first `{` to the last `}` in a larger
 * non-JSON string — correct for the common single-object case (nested
 * double-wrapped errors don't nest braces inside the outer text). Shared by
 * `unwrapString` (message-only) and `extractGatewayErrorDetails` (full
 * structured envelope) below.
 */
function embeddedJsonSubstring(str: string): string | undefined {
  const start = str.indexOf('{');
  const end = str.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return undefined;
  return str.slice(start, end + 1);
}

/** The one-level `message`/`error`/`data.message`/`error.message` read the
 *  gateway-envelope code below still uses for its own `message` field. */
function extractErrorFromObject(obj: unknown): string | undefined {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return undefined;
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
  attemptFailures?: GatewayAttemptFailure[];
}

export interface GatewayAttemptFailure {
  attempt: number;
  provider: string;
  routeModel: string;
  resolvedModel: string;
  stage: string;
  status?: number;
  code: string | number;
  message: string;
}

function attemptFailuresFrom(value: unknown): GatewayAttemptFailure[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const failures: GatewayAttemptFailure[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const failure = item as Record<string, unknown>;
    if (
      !Number.isInteger(failure.attempt) ||
      (failure.attempt as number) < 1 ||
      typeof failure.provider !== 'string' ||
      !failure.provider ||
      typeof failure.route_model !== 'string' ||
      !failure.route_model ||
      typeof failure.resolved_model !== 'string' ||
      !failure.resolved_model ||
      typeof failure.stage !== 'string' ||
      !failure.stage ||
      (typeof failure.code !== 'string' &&
        !(typeof failure.code === 'number' && Number.isFinite(failure.code))) ||
      typeof failure.message !== 'string' ||
      !failure.message ||
      (failure.status !== undefined &&
        (!Number.isInteger(failure.status) ||
          (failure.status as number) < 100 ||
          (failure.status as number) > 599))
    ) {
      continue;
    }
    failures.push({
      attempt: failure.attempt as number,
      provider: failure.provider,
      routeModel: failure.route_model,
      resolvedModel: failure.resolved_model,
      stage: failure.stage,
      ...(typeof failure.status === 'number' ? { status: failure.status } : {}),
      code: failure.code,
      message: failure.message,
    });
  }
  return failures.length > 0 ? failures : undefined;
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
  const suggestion =
    typeof obj.suggestion === 'string' && obj.suggestion ? obj.suggestion : undefined;
  const upstreamStatus = typeof obj.upstream_status === 'number' ? obj.upstream_status : undefined;
  const requestId =
    typeof obj.request_id === 'string' && obj.request_id ? obj.request_id : undefined;
  const attemptFailures = attemptFailuresFrom(obj.attempt_failures);
  if (
    !provider &&
    !code &&
    !suggestion &&
    upstreamStatus === undefined &&
    !requestId &&
    !attemptFailures
  )
    return undefined;
  const message =
    (typeof obj.message === 'string' && obj.message) || extractErrorFromObject(obj) || '';
  return { message, provider, code, suggestion, upstreamStatus, requestId, attemptFailures };
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
    const str = stripErrorPrefixes(raw);
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
  // OpenCode's `UnknownError` has no `responseBody` — `String(err)` is all it
  // keeps, in `data.message`. When that string IS the gateway body (a JSON
  // string, possibly prefixed), the envelope is still in there.
  if (data && typeof data.message === 'string') {
    const fromMessage = extractGatewayErrorDetails(data.message);
    if (fromMessage) return fromMessage;
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
