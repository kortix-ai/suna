/**
 * A GENERATED migration must be born with the same safety header a
 * hand-written one gets.
 *
 * `migrate:create` has pre-filled `set lock_timeout` / `set statement_timeout`
 * since the zero-downtime policy landed. `migrate:generate` did not — it
 * renamed drizzle-kit's output into migrations/ untouched. So every generated
 * migration started life failing squawk's `require-timeout-settings`, and only
 * passed if the author noticed and pasted the header in by hand.
 *
 * That is not a hypothetical: 20260805030712000_enterprise_entitled_flag.sql
 * was generated, shipped without the header, merged with the check red, and
 * then failed the lint on every unrelated PR afterwards — because squawk's
 * target set is "every non-exempt migration", not "the ones this PR adds".
 *
 * The two scripts hold the header text separately, so these tests pin the part
 * that must not drift: the timeout statements themselves.
 */
import { describe, expect, test } from 'bun:test';

const GENERATE = await Bun.file(new URL('./generate.ts', import.meta.url).pathname).text();
const CREATE = await Bun.file(new URL('./create-migration.ts', import.meta.url).pathname).text();

/** The `set <name> = '<value>';` statements a template emits into the SQL. */
function timeouts(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of src.matchAll(/set (lock_timeout|statement_timeout) = '([^']+)'/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

describe('generate.ts safety header', () => {
  test('emits both timeout statements', () => {
    const t = timeouts(GENERATE);
    expect(t.lock_timeout).toBeDefined();
    expect(t.statement_timeout).toBeDefined();
  });

  test('uses the SAME values as the hand-written template', () => {
    // Two headers that disagree would make "which command did you use?" a
    // silent input to how safe the migration is.
    expect(timeouts(GENERATE)).toEqual(timeouts(CREATE));
  });

  test('prepends the header to the generated file, not just prints it', () => {
    // The original bug was cosmetic-looking and total: the script only ever
    // renamed drizzle's file. Advice on stdout does not reach the linter.
    expect(GENERATE).toContain('safetyHeader(slug)');
    expect(GENERATE).toContain('writeFileSync');
  });

  test('the header carries the enforced annotation lines', () => {
    // lint-migrations.ts fails any DROP/RENAME/ALTER TYPE without these, and a
    // generated diff is exactly where an unreviewed one appears.
    expect(GENERATE).toContain('mixed-version-safe:');
    expect(GENERATE).toContain('enum-value-checked:');
  });

  test('tells the author to review the generated SQL', () => {
    // drizzle knows the target shape, not how to reach it without downtime.
    expect(GENERATE).toContain('REVIEW THE GENERATED SQL');
  });
});
