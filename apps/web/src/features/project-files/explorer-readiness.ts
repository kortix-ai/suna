/**
 * Is the file explorer waiting for something that will actually arrive?
 *
 * The sandbox proxy answers a read against a box that is not up with the same
 * `503 sandbox_not_ready` in two very different situations, and the difference
 * decides whether waiting is honest:
 *
 *  - **booting** — the proxy reached the box and OpenCode is still coming up.
 *    It becomes healthy on its own, so polling is right and "starting…" is
 *    true.
 *  - **parked** — the platform answered from the session row without dialling
 *    anything (`hop === 'control_plane'`). A read is deliberately not allowed
 *    to wake it (`shouldAutoResumeStoppedSandbox` refuses every GET on a
 *    session-data port), so it resumes only on the next SEND. Polling is an
 *    unbounded loop against a request the API will keep refusing, and
 *    "starting…" is false.
 *
 * The explorer used to call both "waking" and poll forever, which is how an
 * idle session showed a Files panel that alternated skeleton and spinner until
 * the tab was closed. The terminal panel reached the same fork earlier and
 * answered it correctly — see `nextPtyAttachStep`'s `pause: 'asleep'` in
 * `features/session/pty-connection.ts`. This is that answer, for files.
 *
 * Pure so the fork is a test rather than a habit.
 */
export type ExplorerReadiness =
  /** Nothing is blocking the listing. Render it. */
  | { kind: 'ready' }
  /** The box is coming up. Keep polling and say so. */
  | { kind: 'waking' }
  /** The box is asleep and only a send wakes it. Stop polling and say THAT. */
  | { kind: 'asleep' };

/**
 * Cadence for the wake poll. Unchanged from the interval the panel already
 * ran — the fix is not that 3s was too fast, it is that it never stopped.
 */
export const EXPLORER_WAKE_POLL_MS = 3_000;

export function explorerReadinessState(input: {
  /** The listing failed with a sandbox-readiness 503 (parked or booting). */
  hasReadinessError: boolean;
  /** The connection store says the platform answered from the session row. */
  parked: boolean;
}): ExplorerReadiness {
  // `parked` alone is not a reason to announce anything. On a cold paint the
  // store can already know the box is asleep while the listing has not been
  // refused yet — and a cached listing renders perfectly well over a parked
  // box. Only an actual refusal turns this into something to say.
  if (!input.hasReadinessError) return { kind: 'ready' };
  return input.parked ? { kind: 'asleep' } : { kind: 'waking' };
}
