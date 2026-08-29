/**
 * Whether the GENERATING indicator ("Gathering thoughts…", the shimmer) may
 * paint right now.
 *
 * This is a narrower question than `projectWorking`'s `state`, and the split is
 * the point. `state` answers "should the composer hold, should commands wait" —
 * questions where acting on a stale-but-plausible open turn is the SAFE
 * direction. The indicator answers "tell the user the agent is thinking", where
 * the same stale read is simply a lie on screen.
 *
 * ## The defect this closes
 *
 * Entering a session painted the generating shimmer for ~30-45s over a
 * transcript that was already fully rendered, with nothing running, and then
 * cleared on its own (reported 2026-08-29 on `pi-worker`).
 *
 * The only evidence behind that claim is a `GET .../turn` read — the control
 * plane still holding a row open for a turn nobody is running. The session
 * stream is attached and has PROMISED to carry turn state
 * (`kortix.control.turn`), but those frames are pushed ON CHANGE: a session
 * resumed with a row already open produces no frame, so nothing contradicts the
 * stale read until the observation ages out (`SERVER_OBSERVATION_MAX_MS`).
 *
 * `workingRefetchInterval` already applies exactly this rule to the POLL — it
 * refuses to stand down on a connected-but-uncorroborated stream, for the same
 * reason and citing the same symptom. This applies the rule to what the user
 * SEES, which is the half that was missing.
 *
 * ## Why it cannot hide a real turn
 *
 * The gate is deliberately as small as it can be, and withholds only where all
 * three hold at once:
 *
 *  - the claim rests on the SERVER read alone. A runtime that is actually
 *    producing output reaches the projection as `stream` (its own voice, or the
 *    content-first activity rule), and this tab's own send reaches it as
 *    `optimistic`. Neither is ever withheld.
 *  - a stream is CONNECTED. With no stream there is no promise outstanding, the
 *    server read is all there is, and it decides — a surface with no stream
 *    must never go quiet over a running turn.
 *  - that stream has NOT yet answered about turns. The moment it does, the
 *    indicator paints.
 *
 * So the worst case is a real turn whose indicator waits for the first control
 * frame on an attached stream, which is the same instant the transcript starts
 * moving.
 */

import type { WorkingProjection } from './working';

export function showsGeneratingIndicator(input: {
  projection: Pick<WorkingProjection, 'state' | 'source'>;
  /** A session stream is attached for this scope — it has promised an answer. */
  streamConnected: boolean;
  /**
   * A `kortix.control.turn` frame has arrived since the CURRENT attach.
   * Absent means the caller does not track it, and is treated as corroborated
   * so this can only ever withhold on a positive "not answered yet".
   */
  streamCorroborated?: boolean;
}): boolean {
  if (input.projection.state !== 'working') return false;
  if (input.projection.source !== 'server') return true;
  if (!input.streamConnected) return true;
  return input.streamCorroborated ?? true;
}
