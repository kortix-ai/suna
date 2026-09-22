/**
 * Fixture for `use-session.react-native.test.ts`'s detector self-check.
 *
 * Not reachable from any entry point and not part of the public surface. It
 * exists so the RN globals scan can prove it FIRES, without anyone having to
 * temporarily break a real file to find out.
 *
 * The read below is deliberately unguarded — that is the whole point.
 */

/** Would throw `ReferenceError: localStorage is not defined` on Hermes. */
export function readsAnUnguardedGlobal(): string | null {
  return localStorage.getItem('kortix:fixture');
}
