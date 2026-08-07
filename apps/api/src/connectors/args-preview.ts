/**
 * Redacted argument previews for gated connector calls — the "where is this
 * email actually going?" half of a human-in-the-loop approval.
 *
 * WHY THIS EXISTS: `connector_calls` deliberately stores only a
 * `request_digest` (a hash of the inputs, never raw secrets), so an approval
 * prompt could name the tool (`gmail.send_email`) but nothing about its
 * target. A human was being asked to authorise an action whose effect was
 * invisible to them — the one thing an approval gate must never do.
 *
 * The preview is written into the pending row's `result_summary.args_preview`
 * (jsonb, already documented as "redacted") so no migration is needed.
 *
 * SAFETY MODEL — this output is shown in the UI and persisted in the audit
 * trail, so it is built by SUBTRACTION, never by trust:
 *   • Key denylist wins over everything. A key whose segments include a
 *     secret-ish word is replaced with a marker; its value is never copied,
 *     not even truncated.
 *   • Every string is truncated; long opaque blobs (base64 attachment bodies,
 *     data URLs) collapse to a descriptor rather than a prefix, because the
 *     prefix of a credential is still credential material.
 *   • Depth, breadth, and total serialised size are all capped, so a huge
 *     tool payload can't bloat every audit row or the approval page.
 *   • Unknown/exotic values (functions, symbols, class instances) degrade to a
 *     type marker instead of being coerced.
 *
 * Pure and unit-tested: no db, no io, no config.
 */

/** Preserve complete normal email bodies and connector text parameters. */
const MAX_STRING = 20_000;
/** Strings at or above this length with no whitespace are treated as opaque
 *  blobs (base64/token-shaped) and described, not sampled. */
const OPAQUE_BLOB_MIN = 96;
/** Max array items previewed before collapsing into a remainder note. */
const MAX_ARRAY_ITEMS = 10;
/** Max own keys previewed per object. */
const MAX_OBJECT_KEYS = 24;
/** How deep to walk before collapsing to a type marker. */
const MAX_DEPTH = 3;
/** Hard cap on the serialised preview (chars). Keeps audit rows small. */
const MAX_TOTAL_CHARS = 64_000;

export const REDACTED = '[redacted]';

/**
 * Key segments that mean "this value is a credential". Matched per SEGMENT
 * (snake_case, kebab-case, camelCase and dotted keys are all split), so
 * `apiKey`, `api_key` and `auth.token` all redact while `keyword`,
 * `monkey`, and `authors` do not — substring matching would either miss the
 * first group or wrongly redact the second.
 */
const SECRET_SEGMENTS = new Set([
  'secret',
  'secrets',
  'password',
  'passwd',
  'pass',
  'token',
  'apikey',
  'credential',
  'credentials',
  'auth',
  'authorization',
  'cookie',
  'bearer',
  'signature',
  'sig',
  'otp',
  'pin',
  'passcode',
  'privatekey',
  'ssn',
  'cvv',
  'cvc',
  'seed',
  'mnemonic',
  'refresh',
  'accesskey',
]);

/**
 * `key` alone is ambiguous — `gmail.send_email` has no `key` arg, but plenty of
 * tools use `key` as a plain map/lookup key. Redact it only when it is
 * qualified by something credential-shaped (`api_key`, `private_key`,
 * `signing_key`) — bare `key` is preserved.
 */
const KEY_QUALIFIERS = new Set([
  'api',
  'private',
  'public',
  'signing',
  'secret',
  'encryption',
  'access',
  'session',
  'license',
  'licence',
]);

/** Split a key into lowercase word segments across snake, kebab, dot and camel. */
export function keySegments(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .flatMap((part) => part.split(/\s+/))
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

/** True when a key names credential material and its value must never appear. */
export function isSecretKey(key: string): boolean {
  const segments = keySegments(key);
  if (segments.length === 0) return false;
  // Joined form catches `api_key` → `apikey`, `private_key` → `privatekey`.
  if (segments.some((s) => SECRET_SEGMENTS.has(s))) return true;
  const joined = segments.join('');
  if (SECRET_SEGMENTS.has(joined)) return true;
  const keyIndex = segments.indexOf('key');
  if (keyIndex !== -1) {
    // Qualified either side: `api_key`, `key_secret`.
    const neighbours = [segments[keyIndex - 1], segments[keyIndex + 1]].filter(
      (s): s is string => !!s,
    );
    if (neighbours.some((s) => KEY_QUALIFIERS.has(s))) return true;
  }
  return false;
}

/** Describe a long opaque string without leaking any of it. */
function describeBlob(value: string): string {
  return `[${value.length} chars omitted]`;
}

function isOpaqueBlob(value: string): boolean {
  if (value.length < OPAQUE_BLOB_MIN) return false;
  if (value.startsWith('data:')) return true;
  // No whitespace over a long run = not prose. Base64/JWT/hex/token shaped.
  return !/\s/.test(value);
}

interface PreviewState {
  complete: boolean;
}

function previewString(value: string, state: PreviewState): string {
  if (isOpaqueBlob(value)) {
    state.complete = false;
    return describeBlob(value);
  }
  if (value.length <= MAX_STRING) return value;
  state.complete = false;
  return `${value.slice(0, MAX_STRING)}… [+${value.length - MAX_STRING} chars]`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function previewValue(value: unknown, depth: number, state: PreviewState): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
      return previewString(value, state);
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
      return `${value.toString()}n`;
    case 'undefined':
      return undefined;
    case 'function':
      return '[function]';
    case 'symbol':
      return '[symbol]';
    default:
      break;
  }

  if (depth >= MAX_DEPTH) {
    state.complete = false;
    return Array.isArray(value) ? '[array]' : '[object]';
  }

  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => previewValue(item, depth + 1, state));
    if (value.length > MAX_ARRAY_ITEMS) {
      state.complete = false;
      items.push(`… [+${value.length - MAX_ARRAY_ITEMS} more]`);
    }
    return items;
  }

  if (isPlainRecord(value)) return previewRecord(value, depth + 1, state);

  // Dates and other well-known wrappers are useful; anything else that isn't a
  // plain object is NOT walked (a class instance can hide getters with side
  // effects, and its shape is not ours to publish).
  if (value instanceof Date) return value.toISOString();
  state.complete = false;
  return '[object]';
}

function previewRecord(
  input: Record<string, unknown>,
  depth: number,
  state: PreviewState,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys = Object.keys(input);
  for (const key of keys.slice(0, MAX_OBJECT_KEYS)) {
    if (isSecretKey(key)) {
      out[key] = REDACTED;
      continue;
    }
    const previewed = previewValue(input[key], depth, state);
    if (previewed === undefined) continue;
    out[key] = previewed;
  }
  if (keys.length > MAX_OBJECT_KEYS) {
    state.complete = false;
    out['…'] = `[+${keys.length - MAX_OBJECT_KEYS} more fields]`;
  }
  return out;
}

/**
 * Build the redacted preview of a tool call's arguments.
 *
 * Returns `null` when there is nothing meaningful to show (no args, or every
 * field dropped), so callers can omit the key entirely rather than persisting
 * an empty object.
 */
export interface ArgsPreviewDetails {
  preview: Record<string, unknown> | null;
  complete: boolean;
}

export function buildArgsPreviewDetails(args: unknown): ArgsPreviewDetails {
  if (!isPlainRecord(args)) return { preview: null, complete: false };
  const state: PreviewState = { complete: true };
  let preview = previewRecord(args, 1, state);
  if (Object.keys(preview).length === 0) return { preview: null, complete: true };

  // Total-size backstop: drop keys from the end until it fits. Done on the
  // finished preview (not per-field) so the cap holds regardless of shape.
  let serialised = safeStringify(preview);
  if (serialised.length <= MAX_TOTAL_CHARS) return { preview, complete: state.complete };

  const entries = Object.entries(preview);
  state.complete = false;
  while (entries.length > 0 && serialised.length > MAX_TOTAL_CHARS) {
    entries.pop();
    preview = Object.fromEntries(entries);
    preview['…'] = '[truncated]';
    serialised = safeStringify(preview);
  }
  return {
    preview: Object.keys(preview).length > 0 ? preview : null,
    complete: state.complete,
  };
}

export function buildArgsPreview(args: unknown): Record<string, unknown> | null {
  return buildArgsPreviewDetails(args).preview;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/**
 * The human-facing one-liner for a gated call: the fields that answer "who/what
 * does this touch?" pulled out of an already-redacted preview, in priority
 * order. Used for the approval page's summary line and any out-of-band delivery
 * (WhatsApp/email) where only one line fits.
 */
const SUBJECT_KEYS = [
  'to',
  'recipient',
  'recipients',
  'email',
  'channel',
  'chat_id',
  'phone',
  'url',
  'path',
  'repo',
  'query',
  'subject',
  'title',
  'name',
];

export function summarizeArgsPreview(
  preview: Record<string, unknown> | null | undefined,
): string | null {
  if (!preview) return null;
  const parts: string[] = [];
  for (const key of SUBJECT_KEYS) {
    const value = preview[key];
    if (value === undefined || value === null || value === REDACTED) continue;
    const rendered = Array.isArray(value)
      ? value.filter((v) => typeof v === 'string' || typeof v === 'number').join(', ')
      : typeof value === 'string' || typeof value === 'number'
        ? String(value)
        : null;
    if (!rendered) continue;
    parts.push(`${key}: ${rendered}`);
    if (parts.length === 3) break;
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}
