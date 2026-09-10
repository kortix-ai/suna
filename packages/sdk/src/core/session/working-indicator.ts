/**
 * Whether the GENERATING indicator ("Gathering thoughts…", the shimmer) may
 * paint right now.
 *
 * ## The rule, in one line
 *
 * The agent is generating when the RUNTIME says so. A poll never says so.
 *
 * `projectWorking` answers a broader question — "is a turn open" — from three
 * kinds of evidence, and only one of them is the runtime's own voice:
 *
 *  - `stream`  — SSE frames from the runtime, including the content-first
 *                activity rule. This IS the agent generating. Show it.
 *  - `optimistic` — this tab just sent a prompt and holds the receipt. The user
 *                pressed send a moment ago and the stream takes over within
 *                milliseconds; withholding here would put a visible dead gap
 *                between the click and any feedback.
 *  - `server`  — a `GET .../turn` read. This says a ROW IS OPEN in the control
 *                plane's ledger, which is a different fact and is routinely
 *                stale: rows are closed by a separate relay, so one can outlive
 *                its turn by minutes or hours. It must NEVER paint the shimmer.
 *
 * ## What this replaces
 *
 * The first version of this gate withheld a server-sourced claim only while the
 * stream had not yet corroborated it, and let it through once a
 * `kortix.control.turn` frame arrived. That frame carries the same ledger rows,
 * so a stale row corroborated itself and the shimmer came back — observed on
 * pi.kortix.com over a fully rendered transcript with the composer on Stop.
 * Corroboration was answering "has the stream spoken", when the question is
 * "is the RUNTIME producing output". Only the source can answer that.
 *
 * ## What still uses the broader answer
 *
 * The composer keeps `projectWorking`'s ungated `state`. Holding `/` commands
 * over a turn that MIGHT be open is the safe direction — a command goes
 * straight at the runtime with no admission gate. Telling the user the agent is
 * thinking when it is not is simply false. Two questions, two answers.
 */

import type { WorkingProjection } from './working';

export function showsGeneratingIndicator(input: {
  projection: Pick<WorkingProjection, 'state' | 'source'>;
}): boolean {
  if (input.projection.state !== 'working') return false;
  // The allowlist is the point: a source this does not name cannot paint the
  // shimmer, so a new observer added later is silent until someone decides it
  // represents the runtime actually generating.
  return input.projection.source === 'stream' || input.projection.source === 'optimistic';
}
