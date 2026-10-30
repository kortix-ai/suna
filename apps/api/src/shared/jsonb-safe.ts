/**
 * Make a JSON value storable as Postgres jsonb and in text columns.
 *
 * Postgres jsonb cannot store a string whose text carries U+0000 or an
 * unpaired surrogate: the INSERT that carries one fails with
 * `unsupported Unicode escape sequence — \u0000 cannot be converted to text.`
 * (SQLSTATE 22P05), and a raw NUL byte in a text parameter fails with
 * `invalid byte sequence for encoding "UTF8": 0x00` (SQLSTATE 22021). A write
 * that carries one fails deterministically on its content — one such message
 * retried the same doomed transaction at every turn end (568 warn lines in one
 * prod hour, KRTX-1701, `session_transcript_mirrors`) and again through the
 * session-log journal (KRTX-2178, `session_log_*`).
 *
 * `jsonbSafeValue` therefore makes every string it emits storable: U+0000 and
 * a lone surrogate become U+FFFD. The test is unicode-aware (`/u`), so an
 * astral character's surrogate halves never match — emoji and every BMP char
 * pass through untouched. Well-formed text pays only the scan.
 */

const JSONB_UNSAFE = /[\0\uD800-\uDFFF]/u;

const jsonbSafeText = (text: string): string =>
  JSONB_UNSAFE.test(text) ? text.replace(/[\0\uD800-\uDFFF]/gu, '\uFFFD') : text;

/** Pure: every string in a JSON value, keys included, is storable as jsonb. */
export function jsonbSafeValue<T>(value: T): T {
  if (typeof value === 'string') return jsonbSafeText(value) as T;
  if (Array.isArray(value)) return value.map(jsonbSafeValue) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [jsonbSafeText(key), jsonbSafeValue(item)]),
    ) as T;
  }
  return value;
}
