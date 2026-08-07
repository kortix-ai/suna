import type { ProvisionPhase } from '@kortix/sdk';

/**
 * The four phases `POST /projects/provision-stream` reports, in the order the
 * server walks them (`apps/api/src/projects/provision-core.ts`, mirrored in
 * `packages/sdk`'s own `ProvisionPhase` doc comment).
 *
 * These are REAL, not a guessed timeline. The server emits each one
 * immediately before the work it names, so a step that sits on "Creating
 * repository" is genuinely creating a repository. A time-based checklist was
 * considered and rejected: it stalls on whichever step was guessed wrong, and
 * a progress UI that lies is worse than a spinner that says nothing.
 *
 * Two server behaviours this list deliberately does NOT try to work around
 * (both confirmed in the API's own review):
 * - `seeding` fires before the server's `if (seedStarter)` check, so it also
 *   fires on the opted-out path. Moving it earlier would strand the UI on
 *   "registering" as the terminal phase for that path.
 * - On a unique-index race, `creating_repository` and `registering` can both
 *   fire again and the terminal `done` can carry a DIFFERENT project than the
 *   one this call created. Nothing here — or in the caller — may assume the
 *   streamed project is the one just requested; render whatever `done`
 *   carries.
 */
export const PHASE_ORDER: ProvisionPhase[] = [
  'validating',
  'creating_repository',
  'registering',
  'seeding',
];

export const PHASE_LABELS: Record<ProvisionPhase, string> = {
  validating: 'Checking the name',
  creating_repository: 'Creating repository',
  registering: 'Registering workspace',
  seeding: 'Adding starter files',
};

export type PhaseState = 'done' | 'active' | 'pending';

/**
 * The full four-row checklist for one moment in a provision — every phase in
 * `PHASE_ORDER`, each tagged `done` (strictly before `current`), `active`
 * (equal to `current`), or `pending` (strictly after `current`, or `current`
 * is `null`, before the first event arrives).
 */
export function phaseStatuses(
  current: ProvisionPhase | null,
): { phase: ProvisionPhase; label: string; state: PhaseState }[] {
  const currentIndex = current ? PHASE_ORDER.indexOf(current) : -1;
  return PHASE_ORDER.map((phase, index) => ({
    phase,
    label: PHASE_LABELS[phase],
    state: index < currentIndex ? 'done' : index === currentIndex ? 'active' : 'pending',
  }));
}
