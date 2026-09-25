/**
 * The one UUID shape check for the API.
 *
 * It accepts what a PostgreSQL `uuid` column accepts in canonical form: 8-4-4-4-12
 * hex digits, any case, any version and variant nibble. A malformed id that
 * reaches a `::uuid` cast fails with SQLSTATE 22P02, which surfaces as a 500, so
 * route guards call `isUuid` first and answer 400 or 404 instead. The check must
 * accept every id the database stores. A stricter RFC 4122 form refused ids that
 * other paths wrote, so an id could pass on write and fail on read.
 *
 * Route contracts that validate with zod `z.string().uuid()` are separate and
 * stay as they are.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A string that passed `isUuid`. The brand keeps the false branch honest: with
 * `value is string`, a `string` argument that fails the check narrows to
 * `never`, so code after `if (isUuid(s)) return` would type-check against
 * nothing. A `Uuid` is still a `string` everywhere one is expected.
 */
export type Uuid = string & { readonly __brand: 'Uuid' };

export function isUuid(value: unknown): value is Uuid {
  return typeof value === 'string' && UUID_RE.test(value);
}
