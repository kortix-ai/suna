/**
 * Last-line redaction for everything the runner writes to disk.
 *
 * `client.ts` masks well-known header/body keys at capture time, but a token
 * also reaches the result tree through paths no key list can see: a CLI
 * process's stdout, an assertion's raw `actual`, a URL in a reason string.
 * `results.json` (and `report.html`, a projection of it) is uploaded as a
 * public workflow artifact, so the tree is scrubbed by SHAPE right before it
 * is written. The CI guard step greps the written files with the same shapes
 * (`GUARD_PATTERN_SOURCE`); scrubbing here is what keeps that guard green.
 *
 * Dependency-free (no `bun:` imports): the unit lane loads it under vitest.
 */

/**
 * Exactly the pattern the workflow guard steps grep for. Keep the two in sync
 * — `scrub-secret-shapes.test.ts` asserts every guard step embeds this string.
 */
export const GUARD_PATTERN_SOURCE =
  'kortix_(pat|sa)_[A-Za-z0-9]{12,}|sk-[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{30,}\\.';

/**
 * Wider than the guard on purpose: a base64url JSON blob starting `eyJ` with no
 * `.` after it is still a credential (setup-link and app tokens carry
 * `{accountId, nonce, exp}` / `{appId, userId, exp}`), even though the guard's
 * JWT-style `\.` anchor would let it through.
 */
const SECRET_SHAPES =
  /kortix_(?:pat|sa)_[A-Za-z0-9]{12,}|sk-[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{30,}(?:\.[A-Za-z0-9_-]+)*/g;

/** Same visual shape as client.ts `mask()`: 6-char head, then `***[len]`. */
function maskSecret(value: string): string {
  return `${value.slice(0, 6)}***[${value.length}]`;
}

export function scrubSecretShapes(text: string): string {
  return text.replace(SECRET_SHAPES, maskSecret);
}

/** Deep copy of `value` with every string scrubbed. Non-strings are untouched. */
export function scrubValue<T>(value: T): T {
  if (typeof value === 'string') return scrubSecretShapes(value) as T;
  if (Array.isArray(value)) return value.map(scrubValue) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[scrubSecretShapes(k)] = scrubValue(v);
    }
    return out as T;
  }
  return value;
}
