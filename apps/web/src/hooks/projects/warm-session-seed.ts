import type { ProjectSession } from '@kortix/sdk';

/**
 * JAY-599 / T21 — an adopted warm session must appear in the session list
 * immediately, not seconds later when the sandbox wakes.
 *
 * Root cause: a warm session is hidden from the `visible` list scope by
 * `metadata.warm` (`apps/api/src/projects/lib/session-inventory.ts`). The
 * server now drops that marker at adoption time — the first `POST .../start`
 * call, `apps/api/src/projects/routes/r8.ts` — instead of waiting for the
 * first accepted TURN, seconds later, behind the whole sandbox boot window.
 * That closes the gap for everyone ELSE reading the list, but the adopting
 * tab itself still has to wait for its own `invalidateQueries` refetch to
 * round-trip. This function is the zero-latency half: insert the row the
 * warm ensure already returned (`WarmSession.session`,
 * `use-warm-project-session.ts`) directly into the cache the instant the send
 * happens, so THIS tab never waits on the network at all.
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
 * The seeded copy is the row AS THE SERVER WILL REPORT IT once adoption
 * lands: `metadata.warm` removed and `last_activity_at` stamped — the same
 * two writes `/start`'s `dropWarmSessionMarkerOnAdopt` makes in one statement
 * (`apps/api/src/projects/routes/warm-sessions.ts`). Seeding the raw
 * create-time row instead carried `warm: true` and no activity stamp, so the
 * sidebar's activity sort (`project-session-list-helpers.ts`) placed the
 * just-started session at its CREATE time — the start of the user's dwell on
 * the project home — burying it below sessions that were active more
 * recently. `adoptedAtIso` is injected (never read from a clock here) so the
 * transform stays pure and the caller's timestamp is the single truth.
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
 * Warm adoption: the row only becomes visible when `/start` drops
 * `metadata.warm`. An invalidate issued alongside the `/start` prefetch races
 * it — when the list GET wins, the server response (row still hidden)
 * overwrites the optimistic seed above and, with `refetchOnWindowFocus`
 * disabled, the just-started session stays missing from the sidebar for up to
 * the 60s open-session poll. Deferring the invalidate until the prefetch
 * settles makes the refetch observe the drop. `started` is
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
