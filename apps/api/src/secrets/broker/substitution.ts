// The secret representation/substitution engine: the four encodings of one
// string, the buffer substitution of handles for secrets, and the response-side
// redaction that is its exact dual.
import type { SecretEgressPolicy } from '@kortix/db';
import { REDACTED, SecretBrokerError } from './errors';

// ── Representations ─────────────────────────────────────────────────────────

/**
 * The four ways one string can appear in an HTTP request or response.
 *
 * ONE list, used in both directions: `redactSecretFromResponse` scans for these
 * representations of a SECRET and writes `[REDACTED]`; `substituteBuffer` scans
 * for these representations of a HANDLE and writes the same representation of
 * the secret. Substitution is the exact dual of redaction, so a representation
 * either path can miss is a representation the other misses too — which is the
 * only way the two can stay honest about each other.
 */
export type SecretEncoding = 'raw' | 'url' | 'base64' | 'json';

const SECRET_ENCODERS: Record<SecretEncoding, (value: string) => string> = {
  raw: (value) => value,
  url: (value) => encodeURIComponent(value),
  base64: (value) => Buffer.from(value).toString('base64'),
  // `JSON.stringify` quotes; the slice drops the quotes and keeps the escapes.
  json: (value) => JSON.stringify(value).slice(1, -1),
};

const SECRET_ENCODINGS: readonly SecretEncoding[] = ['raw', 'url', 'base64', 'json'];

export function encodeSecretRepresentation(value: string, encoding: SecretEncoding): string {
  return SECRET_ENCODERS[encoding](value);
}

/**
 * Every DISTINCT representation of `value`, most-preferred encoding first.
 *
 * Handles are `[A-Za-z0-9_-]`-safe by construction (`mintHandle`), so `raw`,
 * `url` and `json` usually collapse to the same bytes. That collapse is exactly
 * where the request stops carrying information: an occurrence tells us nothing
 * about which encoding the caller MEANT, and the answer decides what we write
 * back — a raw value in a URL query, or a percent-encoded one. `primary`
 * resolves it per surface (the caller knows whether it is holding a header, a
 * query string or a JSON body); ties go to the first listed.
 */
export function secretRepresentations(
  value: string,
  primary: SecretEncoding = 'raw',
): Array<{ encoding: SecretEncoding; text: string }> {
  const order = [primary, ...SECRET_ENCODINGS.filter((encoding) => encoding !== primary)];
  const seen = new Set<string>();
  const out: Array<{ encoding: SecretEncoding; text: string }> = [];
  for (const encoding of order) {
    const text = SECRET_ENCODERS[encoding](value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push({ encoding, text });
  }
  return out;
}

/** One secret this session may spend on this request, and the handle that
 *  stands in for it inside the sandbox. `policy` is the FROZEN snapshot the
 *  handle was minted against — re-matched per redirect hop, never trusted from
 *  the hop that started the relay. */
export interface SecretSubstitution {
  identifier: string;
  handle: string;
  value: string;
  policy: SecretEgressPolicy;
}

/**
 * Replace every representation of every handle with the SAME representation of
 * its secret. `applied` collects the identifiers that actually matched, for the
 * audit record and for response redaction.
 */
export function substituteBuffer(
  source: Buffer,
  substitutions: readonly SecretSubstitution[],
  primary: SecretEncoding,
  applied: Set<string>,
): Buffer {
  let result = source;
  for (const substitution of substitutions) {
    for (const { encoding, text } of secretRepresentations(substitution.handle, primary)) {
      const next = replaceBuffer(
        result,
        Buffer.from(text),
        Buffer.from(encodeSecretRepresentation(substitution.value, encoding)),
      );
      if (next !== result) applied.add(substitution.identifier);
      result = next;
    }
  }
  return result;
}

export function substituteString(
  value: string,
  substitutions: readonly SecretSubstitution[],
  primary: SecretEncoding,
  applied: Set<string>,
): string {
  return substituteBuffer(Buffer.from(value), substitutions, primary, applied).toString('utf8');
}

/** Which encoding a body's own content type says its bytes are written in. */
export function bodyEncoding(contentType: string | undefined): SecretEncoding {
  const type = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (type === 'application/json' || type.endsWith('+json')) return 'json';
  if (type === 'application/x-www-form-urlencoded') return 'url';
  return 'raw';
}

/**
 * A compressed request body does not contain the handle's bytes, so the scan
 * would find nothing and the guest's request would leave carrying the literal
 * handle. The shim already forces `accept-encoding: identity` on the response
 * side for the mirror-image reason (an echoed secret cannot be redacted out of
 * gzip); this asserts the request side rather than failing silently.
 */
export function assertIdentityRequestBody(headers: Record<string, string>): void {
  const encoding = headers['content-encoding']?.trim().toLowerCase();
  if (encoding && encoding !== 'identity') {
    throw new SecretBrokerError(
      'invalid_request',
      'request bodies must use identity content-encoding',
      400,
    );
  }
}

/** Every occurrence of `needle` replaced by `replacement`. Returns the SAME
 *  buffer object when nothing matched, which is how callers detect a hit
 *  without a second scan. */
function replaceBuffer(source: Buffer, needle: Buffer, replacement: Buffer): Buffer {
  if (needle.byteLength === 0) return source;
  const chunks: Buffer[] = [];
  let cursor = 0;
  for (;;) {
    const index = source.indexOf(needle, cursor);
    if (index === -1) break;
    chunks.push(source.subarray(cursor, index), replacement);
    cursor = index + needle.byteLength;
  }
  if (cursor === 0) return source;
  chunks.push(source.subarray(cursor));
  return Buffer.concat(chunks);
}

export function redactSecretFromResponse(body: Buffer, secret: string): Buffer {
  let result = body;
  for (const { text } of secretRepresentations(secret)) {
    result = replaceBuffer(result, Buffer.from(text), REDACTED);
  }
  return result;
}
