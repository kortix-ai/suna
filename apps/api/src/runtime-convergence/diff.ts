/**
 * The diff of the desired and actual runtime documents — the ONE place
 * convergence is computed (Rule 1, the runtime-convergence contract (PR #7785)). The
 * admission gate (./admission.ts) and `GET /config`'s `runtime` block both read
 * this verdict; neither re-compares the two documents itself.
 *
 * FIELD NAMING CONTRACT: the daemon's `runtime_truth.components` map is keyed
 * by the same five names as the top-level document —
 * `release_id`/`catalog_fingerprint`/`daemon_build`/`cli_sha256`/`managed_skills_hash`
 * — so a component's per-attempt state (state/attempted_at/attempts/cause)
 * lines up 1:1 with the field it describes. Until a box reports `components`
 * at all (every box today), every field reads as `unknown` from the top-level
 * value alone — see the fallback below.
 */

import type { ActualRuntimeDocument, RuntimeComponentReport, RuntimeComponentState } from './actual';
import type { DesiredRuntimeDocument } from './desired';

export type RuntimeOverallState = 'current' | 'converging' | 'blocked';

export interface RuntimeComponentDiff {
  name: keyof DesiredRuntimeDocument;
  desired: string | number | null;
  actual: string | number | null;
  /** Do desired and actual agree on the literal value? Never true when either is null. */
  matches: boolean;
  state: RuntimeComponentState;
  attempted_at: string | null;
  attempts: number;
  cause: string | null;
}

export interface RuntimeDiff {
  overall: RuntimeOverallState;
  desired: DesiredRuntimeDocument;
  actual: ActualRuntimeDocument;
  components: RuntimeComponentDiff[];
}

const FIELDS: Array<keyof DesiredRuntimeDocument> = [
  'release_id',
  'catalog_fingerprint',
  'daemon_build',
  'cli_sha256',
  'managed_skills_hash',
];

function literalMatch(desired: string | number | null, actual: string | number | null): boolean {
  if (desired === null || actual === null) return false;
  return String(desired) === String(actual);
}

/**
 * A component's state, when the box reports NO per-component entry for it.
 * `unknown` is a diff, not a pass (Rule 1): a box that never reports itself at
 * all — every box that predates `runtime_truth` — must never read as
 * `current` merely because a stale cached top-level value happens to match.
 */
function fallbackState(actual: string | number | null, matches: boolean): RuntimeComponentState {
  if (actual === null) return 'unknown';
  return matches ? 'current' : 'converging';
}

export function diffRuntime(desired: DesiredRuntimeDocument, actual: ActualRuntimeDocument): RuntimeDiff {
  const components: RuntimeComponentDiff[] = FIELDS.map((name) => {
    const desiredValue = desired[name];
    const actualValue = actual[name];
    const matches = literalMatch(desiredValue, actualValue);
    const reported: RuntimeComponentReport | undefined = actual.components[name];
    return {
      name,
      desired: desiredValue,
      actual: actualValue,
      matches,
      // The box's own per-component report is authoritative over the literal
      // compare above: it may be mid-attempt (`converging`) even though the
      // last-known value it reported happens to already match, or it may
      // declare itself unable to ever converge (`blocked`) regardless of the
      // current value.
      state: reported ? reported.state : fallbackState(actualValue, matches),
      attempted_at: reported?.attempted_at ?? null,
      attempts: reported?.attempts ?? 0,
      cause: reported?.cause ?? null,
    };
  });

  const overall: RuntimeOverallState = components.some((c) => c.state === 'blocked')
    ? 'blocked'
    : components.every((c) => c.state === 'current')
      ? 'current'
      : 'converging';

  return { overall, desired, actual, components };
}
