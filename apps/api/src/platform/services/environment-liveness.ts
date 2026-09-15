/**
 * Is the environment row telling the truth about its box?
 *
 * `ensureSessionEnvironment` short-circuits on `status === 'active' &&
 * externalId` and returns the row without asking the provider anything. That
 * was safe while something reconciled the column, and nothing does: an
 * environment has no `session_sandboxes` row, so `applyStoppedState` (the write
 * every automatic stop path goes through) cannot reach it, and the provider
 * webhook keys on an `externalId` the environment does not have either.
 *
 * Meanwhile the box is created with `autoStopInterval: 60`, so the provider
 * powers it off after an hour of idleness — on its own, silently, by design.
 *
 * The two facts together wedge the session permanently. The row still reads
 * 'active', so `ensure` returns a box that is off; `claimEnvironmentWork`
 * re-claims only 'error', 'stopped' and stale 'provisioning', so it never
 * re-claims this one; and every tool call fails against a dead origin with
 * nothing in the system able to repair it. Measured on pi.kortix.com: 20 of 21
 * environment rows read 'active' with a box attached.
 *
 * This is the missing reconcile, as a pure rule over the provider's answer.
 */
import type { SandboxStatus } from '../providers/status';

/**
 * What `ensure` should do with an 'active' row, given what the provider says
 * about its box.
 *
 * - `serve` — the row is honest, hand it back.
 * - `resume` — the box is off but intact; mark the row 'stopped' so the normal
 *   claim path resumes it.
 * - `reprovision` — the box is gone or dead; mark the row 'error' so the claim
 *   path builds a new one. A removed box cannot be started.
 */
export type EnvironmentLivenessAction = 'serve' | 'resume' | 'reprovision';

export function decideEnvironmentLiveness(boxStatus: SandboxStatus): EnvironmentLivenessAction {
  switch (boxStatus) {
    case 'running':
      return 'serve';
    case 'stopped':
      return 'resume';
    case 'removed':
    case 'terminal':
      return 'reprovision';
    case 'unknown':
      // "Uncertainty must NEVER authorize a kill" (providers/status.ts). A
      // provider we cannot reach is not evidence the box is down, and acting on
      // it would tear down healthy environments during any provider blip.
      // Serving is the recoverable mistake: the next ensure asks again.
      return 'serve';
  }
}

/**
 * What the reconcile must WRITE for an action — and specifically whether the
 * provider id survives.
 *
 * This is a separate decision from the action, and conflating them was a real
 * bug: `reprovision` wrote `status = 'error'` and kept `external_id`, but
 * `runEnvironmentWork` branches on that column —
 *
 *     if (externalId) { await resumeEnvironment(externalId); ... }
 *     // provision happens ONLY in the else
 *
 * — so a removed box was re-claimed out of 'error', sent down the RESUME
 * branch against an id the provider no longer has, failed, and was marked
 * 'error' again. Forever. Clearing the id is the whole mechanism by which a
 * rebuild happens; the status alone decides nothing.
 */
export function environmentReconcileWrite(
  action: EnvironmentLivenessAction,
): { status: 'stopped' | 'error'; clearExternalId: boolean } | null {
  switch (action) {
    case 'serve':
      return null;
    case 'resume':
      // The box is off but intact, and `ensure` resumes it BY id. Keep it.
      return { status: 'stopped', clearExternalId: false };
    case 'reprovision':
      // The box is gone. Keeping its id sends the claim path down the resume
      // branch against something the provider cannot produce.
      return { status: 'error', clearExternalId: true };
  }
}
