/**
 * Reading the truth out of a wrapped error. No imports — every module that
 * needs this is one a database module must be able to depend on, or one that
 * must stay database-free. A leaf keeps both true.
 *
 * The rule this encodes (learnings, 2026-09-10): a wrapper error hides its
 * cause, so never read `.message`. `DrizzleQueryError.message` is the whole
 * generated statement plus its bound parameters; the SQLSTATE that says what
 * actually failed is on `.cause`.
 */

/**
 * The first `code` found walking down the cause chain.
 *
 * FIRST, not deepest, and deliberately so: this is the behaviour
 * `auditErrorSqlstate` has had in production, and it decides whether an audit
 * write is retried. Drizzle's wrapper carries no `code`, so the first hit is
 * the driver's SQLSTATE anyway; the two rules only diverge for an error that
 * synthesises its own code above a driver error, and in that case the outer
 * code is the one the thrower meant us to act on.
 */
export function errorSqlstate(error: unknown): string | null {
  return walk(error, (node) => {
    const code = (node as { code?: unknown }).code;
    return typeof code === 'string' && code.length > 0 ? code : null;
  }, 'first');
}

/**
 * Deepest `message` on the chain. Drizzle wraps the driver error, and it is the
 * driver's message ("canceling statement due to statement timeout") that names
 * the fault.
 */
export function innermostMessage(error: unknown): string | null {
  return walk(error, (node) => {
    const message = (node as { message?: unknown }).message;
    return typeof message === 'string' && message.length > 0 ? message : null;
  }, 'last');
}

/**
 * Walk `.cause`, returning either the first or the last non-null `pick`.
 *
 * Bounded and cycle-safe. These run on an error path, where a hang is the worst
 * possible outcome — worse than a missing detail — so the walk refuses to
 * revisit a node and gives up after 16 links.
 */
function walk(
  error: unknown,
  pick: (node: object) => string | null,
  take: 'first' | 'last',
): string | null {
  let current = error;
  let found: string | null = null;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 16 && current != null; depth++) {
    if (typeof current !== 'object') break;
    if (seen.has(current)) break;
    seen.add(current);
    const value = pick(current);
    if (value !== null) {
      if (take === 'first') return value;
      found = value;
    }
    const cause = (current as { cause?: unknown }).cause;
    if (cause == null) break;
    current = cause;
  }
  return found;
}
