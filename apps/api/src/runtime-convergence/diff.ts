/**
 * The diff of the desired and actual runtime documents — the ONE place
 * convergence is computed (Rule 1, the runtime-convergence contract (PR #7785)). The
 * admission gate (./admission.ts) and `GET /config`'s `runtime` block both read
 * this verdict; neither re-compares the two documents itself.
 *
 * FIELD NAMING CONTRACT — CORRECTED. The daemon's `runtime_truth.components`
 * map is NOT keyed by the same names as this file's top-level document. The
 * box side (`apps/kortix-sandbox-agent-server/src/runtime-truth.ts`,
 * `RUNTIME_TRUTH_COMPONENT_NAMES`) uses
 * `config_release`/`catalog`/`daemon`/`cli`/`managed_skills`; this file's
 * `DesiredRuntimeDocument` uses
 * `release_id`/`catalog_fingerprint`/`daemon_build`/`cli_sha256`/`managed_skills_hash`.
 * Zero overlap. #7792 (box) and #7793 (API) each shipped correct in
 * isolation and were never wired end to end against a real daemon: looking
 * `actual.components[name]` up with an API-side name always missed, so every
 * component silently fell back to a literal-value compare — `attempts`,
 * `attempted_at` and `cause` were always `0`/`null`/`null`, `blocked` could
 * never surface, and a real `cause` the box reported (e.g. "opencode has not
 * built a provider config yet") was thrown away one layer below the API.
 * `COMPONENT_KEY_BY_FIELD` below is the explicit mapping; `diff.test.ts`
 * asserts it is total in both directions against a literal mirror of the
 * box's own name list, so a rename on either side fails a test here instead
 * of silently reintroducing this.
 */

import type { ActualRuntimeDocument, RuntimeComponentReport, RuntimeComponentState } from './actual';
import type { DesiredRuntimeDocument } from './desired';

/**
 * `unknown` — ADDED alongside the original three (`current`/`converging`/
 * `blocked`). Before this, an all-`unknown`, zero-attempt, unreachable box
 * rolled up to `converging` by falling through every other branch — the same
 * defect Rule 1 exists to remove, one level up: a verdict that reports
 * progress it cannot back. `converging` now REQUIRES evidence of a live or
 * recent attempt (see `diffRuntime`); a box nothing has ever tried to
 * converge is `unknown`, not `converging`. No live reader in this repo
 * switches on `RuntimeOverallState` yet (checked before adding this), so this
 * is additive with nothing to migrate; a future UI consumer must handle all
 * four names.
 */
export type RuntimeOverallState = 'current' | 'converging' | 'blocked' | 'unknown';

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
  /** Set only when `overall === 'unknown'` — the provable reason, for a field the UI can render instead of a bare state name. */
  overall_reason: string | null;
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

/**
 * The box's `runtime_truth.components` key for each field this file names.
 * Source of truth for the box side: `RUNTIME_TRUTH_COMPONENT_NAMES` in
 * `apps/kortix-sandbox-agent-server/src/runtime-truth.ts` — a different app,
 * so it cannot be imported here; `diff.test.ts` mirrors that literal list and
 * asserts every value below appears in it exactly once, and every value in
 * it is used as a mapping target exactly once, so this cannot drift silently
 * again in either direction.
 */
const COMPONENT_KEY_BY_FIELD: Record<keyof DesiredRuntimeDocument, string> = {
  release_id: 'config_release',
  catalog_fingerprint: 'catalog',
  daemon_build: 'daemon',
  cli_sha256: 'cli',
  managed_skills_hash: 'managed_skills',
};

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
    const reported: RuntimeComponentReport | undefined = actual.components[COMPONENT_KEY_BY_FIELD[name]];
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

  // A component reporting `converging` itself, or one carrying `attempts > 0`
  // / `attempted_at` set (a report this platform can point to), is EVIDENCE a
  // repair is live or recently ran. Nothing here invents that evidence —
  // `fallbackState` (above) already refuses to call an unattempted mismatch
  // anything but `converging` from the literal compare alone in the ONE case
  // where the box reports a real (non-null) actual value; for the all-null,
  // no-components case this leaves nothing to point to.
  const hasAttemptEvidence = components.some(
    (c) => c.state === 'converging' || c.attempts > 0 || c.attempted_at !== null,
  );
  const overall: RuntimeOverallState = components.some((c) => c.state === 'blocked')
    ? 'blocked'
    : components.every((c) => c.state === 'current')
      ? 'current'
      : hasAttemptEvidence
        ? 'converging'
        : 'unknown';

  const overall_reason = overall === 'unknown' ? overallUnknownReason(actual) : null;

  return { overall, overall_reason, desired, actual, components };
}

/** Why `overall === 'unknown'` — the only thing the diff itself can prove. */
function overallUnknownReason(actual: ActualRuntimeDocument): string {
  if (Object.keys(actual.components).length > 0) return 'component_reports_unknown';
  const allFieldsNull = FIELDS.every((name) => actual[name] === null);
  return allFieldsNull ? 'runtime_truth_not_reported' : 'runtime_truth_partial';
}
