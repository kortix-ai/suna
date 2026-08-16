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
 * Tolerating the reconcile race: the invalidate that follows this seed
 * (`use-new-project-session.ts`) can lose a race with the server's own
 * marker-drop — the sessions-list GET and the adopting `/start` POST are two
 * independent requests with no ordering guarantee between them. If the GET
 * wins, its response still shows the row hidden, and `setQueryData`
 * overwrites this seed with that stale-but-real server list: the row
 * flickers out. This is accepted, not engineered around, because it is
 * bounded and self-healing: the marker-drop is the first thing `/start` does
 * (before any sandbox work), so losing the race is rare in practice, and
 * when it does happen the sidebar's own fast provisioning poll
 * (`projectSessionsRefetchInterval`, `PROVISIONING_POLL_MS`) re-fetches within
 * seconds and the row reappears on its own. The failure mode this replaces —
 * a session invisible for the ENTIRE sandbox boot window — is what actually
 * mattered; a possible one-frame flicker is not.
 */
export function seedAdoptedWarmSession(
  sessions: ProjectSession[] | undefined,
  session: ProjectSession,
): ProjectSession[] {
  if (!sessions) return [session];
  const index = sessions.findIndex((existing) => existing.session_id === session.session_id);
  if (index === -1) return [session, ...sessions];
  const next = sessions.slice();
  next[index] = session;
  return next;
}
