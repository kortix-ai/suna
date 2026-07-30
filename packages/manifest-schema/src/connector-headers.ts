/**
 * `[[connectors]].headers` — arbitrary static request headers sent on EVERY
 * outbound call a connector makes (the "Postman headers table" of a connector).
 *
 * ONE source of truth for the rules, dependency-free (same reason as
 * `constants.ts`: the imperative validator `./index.ts`, the JSON Schema
 * generator `./json-schema.ts`, apps/api's manifest parser
 * (`projects/connectors.ts`) and the executor (`executor/execute.ts`) all need
 * the exact same answer to "is this header legal?", and none of them may
 * import each other.
 *
 * SECURITY — the two rules that are not cosmetic:
 *   1. Names are RFC 7230 `token`s. Anything else (spaces, colons, quotes,
 *      non-ASCII) is rejected outright.
 *   2. Values may not contain CR or LF (or any other control character):
 *      an embedded `\r\n` would let an author append arbitrary extra headers —
 *      or a whole second request — to the outbound message
 *      (header-injection / request-splitting).
 * The credential is NEVER expressible here: the executor drops any static
 * header that collides with the connector's auth header, so a static header
 * can neither spoof nor clobber the credential (see execute.ts
 * `applyConnectorHeaders`).
 *
 * NOT SECRETS — these values live in the manifest (git) in plaintext, exactly
 * like `base_url`. Never put a token/API key in a header value; that is what
 * `auth` + the platform credential store are for. (Referencing a project
 * secret from a header value is deliberately NOT supported in this pass.)
 */

/** RFC 7230 §3.2.6 `token` — the only characters legal in a header field name. */
export const CONNECTOR_HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/** Caps — a connector's header table is configuration, not a payload. */
export const CONNECTOR_HEADERS_MAX_COUNT = 32;
export const CONNECTOR_HEADER_NAME_MAX_LENGTH = 128;
export const CONNECTOR_HEADER_VALUE_MAX_LENGTH = 2048;

/**
 * Headers the transport owns. Setting these by hand either breaks the request
 * or (for the framing ones) opens request-smuggling behaviour against an
 * intermediary, so they are rejected rather than silently dropped.
 */
export const CONNECTOR_FORBIDDEN_HEADER_NAMES: readonly string[] = [
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

/** Why `name` is not a usable header name, or null when it is fine. */
export function connectorHeaderNameError(name: string): string | null {
  if (!name) return 'header name is required';
  if (name.length > CONNECTOR_HEADER_NAME_MAX_LENGTH) {
    return `header name "${name.slice(0, 32)}…" is too long (max ${CONNECTOR_HEADER_NAME_MAX_LENGTH} characters)`;
  }
  if (!CONNECTOR_HEADER_NAME_RE.test(name)) {
    return `invalid header name "${name}" — must be an RFC 7230 token (letters, digits and !#$%&'*+-.^_\`|~)`;
  }
  if (CONNECTOR_FORBIDDEN_HEADER_NAMES.includes(name.toLowerCase())) {
    return `header "${name}" is controlled by the transport and cannot be set`;
  }
  return null;
}

/** Why `value` is not a usable header value, or null when it is fine. */
export function connectorHeaderValueError(name: string, value: string): string | null {
  if (value.length > CONNECTOR_HEADER_VALUE_MAX_LENGTH) {
    return `value for header "${name}" is too long (max ${CONNECTOR_HEADER_VALUE_MAX_LENGTH} characters)`;
  }
  if (/[\r\n]/.test(value)) {
    return `value for header "${name}" must not contain CR or LF (header injection)`;
  }
  // Any other C0 control char / DEL is illegal in a field-value too (RFC 7230
  // §3.2 allows VCHAR, SP and HTAB only).
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    return `value for header "${name}" must not contain control characters`;
  }
  return null;
}

export type ConnectorHeadersParse =
  | { ok: true; value: Record<string, string> }
  | { ok: false; error: string };

/**
 * Normalize + validate a raw `headers` table from a manifest entry.
 *
 * Accepts an ordered map of name → value. Numbers/booleans are coerced to
 * strings (a YAML author writing `X-Api-Version: 2` means the string `"2"`).
 * Names are trimmed, and so are values — but only AFTER they are validated, so
 * a stray CR/LF is reported rather than silently stripped. An empty value is
 * legal (`X-Foo:` is a valid header). Insertion order is preserved.
 * Missing/null → `{}`.
 */
export function parseConnectorHeaders(raw: unknown): ConnectorHeadersParse {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'headers must be a table of header name → value' };
  }

  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > CONNECTOR_HEADERS_MAX_COUNT) {
    return {
      ok: false,
      error: `too many headers (${entries.length}) — at most ${CONNECTOR_HEADERS_MAX_COUNT} are allowed`,
    };
  }

  const value: Record<string, string> = {};
  const seen = new Map<string, string>();
  for (const [rawName, rawValue] of entries) {
    const name = rawName.trim();
    const nameError = connectorHeaderNameError(name);
    if (nameError) return { ok: false, error: nameError };

    // HTTP header names are case-insensitive: two spellings of one header is
    // an authoring mistake with ambiguous semantics, not a pair of headers.
    const lower = name.toLowerCase();
    const previous = seen.get(lower);
    if (previous !== undefined) {
      return { ok: false, error: `duplicate header "${name}" (already set as "${previous}")` };
    }
    seen.set(lower, name);

    if (
      typeof rawValue !== 'string' &&
      typeof rawValue !== 'number' &&
      typeof rawValue !== 'boolean'
    ) {
      return { ok: false, error: `value for header "${name}" must be a string` };
    }
    // Validate BEFORE trimming: a trailing CR would otherwise be silently
    // "fixed" instead of surfacing as the injection attempt it looks like.
    const headerValue = String(rawValue);
    const valueError = connectorHeaderValueError(name, headerValue);
    if (valueError) return { ok: false, error: valueError };

    value[name] = headerValue.trim();
  }

  return { ok: true, value };
}

/**
 * Drop anything that fails validation, keeping the rest. The parser/CRUD layer
 * is where a bad header gets a loud error; this is the executor's fail-SAFE
 * backstop for a row that predates (or somehow bypassed) that validation — an
 * illegal header is never sent, but one bad row doesn't break every call.
 */
export function sanitizeConnectorHeaders(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [rawName, rawValue] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= CONNECTOR_HEADERS_MAX_COUNT) break;
    const name = rawName.trim();
    if (connectorHeaderNameError(name)) continue;
    const lower = name.toLowerCase();
    if (seen.has(lower)) continue;
    if (typeof rawValue !== 'string' && typeof rawValue !== 'number' && typeof rawValue !== 'boolean') {
      continue;
    }
    const value = String(rawValue);
    if (connectorHeaderValueError(name, value)) continue;
    seen.add(lower);
    out[name] = value.trim();
  }
  return out;
}
