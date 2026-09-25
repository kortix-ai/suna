import type { ProjectSession } from '@kortix/sdk';

/**
 * JAY-599 / T21 — an adopted warm session must appear in the session list
 * immediately, not seconds later when the sandbox wakes.
 *
 * Root cause: a warm session is hidden from the `visible` list scope by
 * `metadata.warm` (`apps/api/src/projects/lib/session-inventory.ts`). The
 * server drops that marker at adoption time instead of waiting for the first
 * accepted TURN, seconds later, behind the whole sandbox boot window. TWO
 * routes drop it: the warm CLAIM, in the same transaction that inserts the
 * first prompt (`apps/api/src/projects/routes/warm-sessions.ts`), and
 * `POST .../start` for a take that carried no prompt
 * (`dropWarmSessionMarkerOnAdopt`, `apps/api/src/projects/routes/session-runtime.ts`).
 * That closes the gap for everyone ELSE reading the list, but the adopting
 * tab itself still has to wait for its own `invalidateQueries` refetch to
 * round-trip. This function is the zero-latency half: insert the row the
 * adoption already returned — the claim response, or `WarmSession.session`
 * for a prompt-less take (`use-warm-project-session.ts`) — directly into the
 * cache the instant the send happens, so THIS tab never waits on the network
 * at all.
 *
 * Idempotent and order-preserving: a session id already in the list is
 * replaced in place (never duplicated), so a retried seed for the same id
 * cannot create two rows. `undefined` (nothing cached yet) becomes a fresh
 * one-row list rather than a throw — `use-new-project-session.ts` calls this
 * from a project the sidebar may not have fetched yet (e.g. a background tab).
 *
 * Placed FIRST when new: a just-adopted session is the most recently active
 * one, which is where every other creation path (the ordinary create POST)
 * already expects to see it once the list refetches.
 *
 * The seeded copy removes `metadata.warm` and stamps `last_activity_at`. The
 * two droppers do NOT write the same pair:
 * - the claim (`warm-sessions.ts:383-389`) drops the marker and merges the
 *   pending prompt. It never writes `last_activity_at`.
 * - `dropWarmSessionMarkerOnAdopt` in `/start` (`warm-sessions.ts:130-138`)
 *   drops the marker AND stamps `last_activity_at`. Its `WARM_SESSION_MARKER`
 *   predicate is already false after a claim, so on the claim path it writes
 *   nothing.
 * So on the claim path the seed's `last_activity_at` is AHEAD of the server
 * until prompt delivery stamps one. The sidebar sorts on that key
 * (`project-session-list-helpers.ts`), and until delivery a refetch re-sorts
 * the just-started session back to its warm-CREATE time.
 *
 * Seeding the raw create-time row instead carried `warm: true` and no activity
 * stamp at all, so the sort placed the just-started session at its CREATE time
 * — the start of the user's dwell on the project home — burying it below
 * sessions that were active more recently. `adoptedAtIso` is injected (never
 * read from a clock here) so the transform stays pure and the caller's
 * timestamp is the single truth.
 *
 * The reconcile that follows this seed no longer races the marker-drop:
 * `use-new-project-session.ts` defers its sessions invalidate until the
 * `/start` prefetch settles, by which point the drop is durable server-side.
 */
/**
 * When to reconcile the sessions-list cache with the server after a create.
 *
 * Ordinary create: the row is visible server-side the moment the POST returns,
 * so invalidate immediately.
 *
 * Warm adoption: the row becomes visible when the marker drops. A send with a
 * prompt drops it in the claim, before this runs; a take WITHOUT one drops it
 * in `/start`, and for that path an invalidate issued alongside the `/start`
 * prefetch races it — when the list GET wins, the server response (row still
 * hidden) overwrites the optimistic seed above and, with `refetchOnWindowFocus`
 * disabled, the just-started session stays missing from the sidebar for up to
 * the 60s open-session poll. Deferring the invalidate until the prefetch
 * settles makes the refetch observe the drop on either path. `started` is
 * `prefetchSessionStart`'s return, which never rejects; the rejection arm is
 * belt-and-braces so a future caller cannot wedge the reconcile.
 */
export function reconcileSessionsAfterCreate(input: {
  adoptedWarm: boolean;
  started: Promise<unknown>;
  invalidate: () => void;
}): void {
  if (!input.adoptedWarm) {
    input.invalidate();
    return;
  }
  void input.started.then(input.invalidate, input.invalidate);
}

/**
 * WHICH row an adoption seeds.
 *
 * A send that carried a prompt claims the warm session, and the claim response
 * is that session as the server holds it after the claim transaction. The warm
 * ENTRY's row was created seconds earlier with an empty body: it is still
 * `provisioning` and still carries `metadata.warm`, so seeding it paints a
 * session the server already runs as still starting.
 *
 * A take with no prompt makes no claim and has no response row, so the entry's
 * row is all this tab has; `/start` drops the marker for that path.
 */
export function pickAdoptedWarmSession(
  claimed: ProjectSession | null,
  warmEntrySession: ProjectSession,
): ProjectSession {
  return claimed ?? warmEntrySession;
}

export function seedAdoptedWarmSession(
  sessions: ProjectSession[] | undefined,
  session: ProjectSession,
  adoptedAtIso: string,
): ProjectSession[] {
  const { warm: _warm, ...metadata } = (session.metadata ?? {}) as Record<string, unknown>;
  const adopted: ProjectSession = {
    ...session,
    metadata: { ...metadata, last_activity_at: adoptedAtIso },
  };
  if (!sessions) return [adopted];
  const index = sessions.findIndex((existing) => existing.session_id === adopted.session_id);
  if (index === -1) return [adopted, ...sessions];
  const next = sessions.slice();
  next[index] = adopted;
  return next;
}
