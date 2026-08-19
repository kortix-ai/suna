import type { Context } from 'hono';

/**
 * The caller's KORTIX session id — or null when the caller is not session-bound.
 *
 * `c.get('sessionId')` is overloaded, and the two meanings are not
 * interchangeable:
 *
 *   - `authType: 'pat'`      → a Kortix PROJECT SESSION id (a sandbox connector
 *                              token; `middleware/auth.ts` sets it from the
 *                              validated token row).
 *   - `authType: 'supabase'` → the SUPABASE AUTH SESSION id, i.e. "which browser
 *                              login is this", set purely so the per-account
 *                              session gate can do idle/lifetime/force-logout.
 *
 * Reading the raw context var and calling it a Kortix session is a live bug, not
 * a theoretical one. Every KaaB isolation guard treats a NON-NULL caller session
 * as "a sandbox acting for one end-user, narrow it" — so handing it a browser's
 * Supabase auth session made the platform treat every logged-in human as an
 * agent:
 *
 *   - `mayResolveApproval` refuses a session-bound caller BEFORE the manager
 *     check, so no human could resolve any approval from the dashboard — 403
 *     "An agent cannot resolve its own approval" on every click.
 *   - `maySeeSessionApprovals` compares it to the target session id, so the
 *     needs-input count was 0 for every browser caller and the badge never lit.
 *   - `isSessionVisibleTo` refuses a session-bound caller reaching a sibling
 *     BACKEND session, so a KaaB operator could not see their own backend
 *     sessions in the dashboard at all.
 *
 * The codebase already knew about this collision — `db-deps.ts`'s
 * `projectSessionIdForProjectPrincipal` exists solely to keep the Supabase value
 * out of connector-connection resolution, with the same reasoning. This is that
 * guard, generalised, so the next caller cannot get it wrong by reaching for the
 * obvious context var.
 */
export function callerKortixSessionId(c: Context): string | null {
  // Anything that is not a Supabase browser JWT carries a real Kortix session id
  // when it carries one at all. Allow-listing 'supabase' as the ONLY excluded
  // kind (rather than allow-listing 'pat') keeps a future token kind that mints
  // session-bound credentials working by default — the isolation guards are the
  // things that must not be weakened, and they read this as "narrow me".
  if (c.get('authType') === 'supabase') return null;
  return c.get('sessionId') ?? null;
}
