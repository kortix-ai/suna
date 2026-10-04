/**
 * The wrapper around `evaluateAdmission` that a placement chokepoint calls.
 * Composes the actual document from an already-fetched health body (this
 * module never dials the box itself — see the health-reuse pattern
 * `turn-start-convergence.ts` documents: "the SAME health read answers both
 * questions"), builds the desired document, evaluates admission, and — on
 * refusal — calls `onRefused` ONCE with the check that failed and its cause,
 * so the caller can make the failure observable (an audit event, a structured
 * log) without re-deriving what went wrong.
 */

import { hasConfigReleaseCapability } from '../services/sessions/session-config-release';
import { evaluateAdmission, type RuntimeAdmissionCheck } from './admission';
import { parseActualRuntime } from './actual';
import { computeDesiredRuntime, type DesiredRuntimeDocument } from './desired';

export interface AdmitSandboxRefusedEvent {
  failedCheck: RuntimeAdmissionCheck;
  cause: string;
}

export interface AdmitSandboxDeps {
  /** `resolveDesiredRelease(...).descriptor.release_id` for this session. */
  releaseId: () => Promise<string | null>;
  /** Defaults to `computeDesiredRuntime`; overridable so a test never pays the
   *  real manifest/catalog composition. */
  desiredRuntime?: (releaseId: string | null) => Promise<DesiredRuntimeDocument>;
  /** See `evaluateAdmission`'s `floor` parameter. Defaults to the deployment constant. */
  minDaemonBuild?: number;
  onRefused: (event: AdmitSandboxRefusedEvent) => void;
}

export interface AdmitSandboxInput {
  /**
   * The parsed `GET /kortix/health` body, or `null` for a box that could not
   * be reached at all. A box that answers but predates `runtime_truth` is a
   * body with no `runtime_truth` key — NOT `null` — and is refused on the
   * same "cannot prove anything" grounds by `parseActualRuntime`'s tolerant
   * parsing, never a crash.
   */
  health: { capabilities?: unknown; runtime_truth?: unknown } | null;
}

export async function admitSandboxForSession(
  input: AdmitSandboxInput,
  deps: AdmitSandboxDeps,
): Promise<ReturnType<typeof evaluateAdmission>> {
  const capabilities = input.health?.capabilities;
  const releaseCapability = hasConfigReleaseCapability(capabilities);
  const actual = parseActualRuntime(input.health?.runtime_truth);

  const releaseId = await deps.releaseId();
  const desiredRuntime = deps.desiredRuntime ?? ((id: string | null) => computeDesiredRuntime({ releaseId: id }));
  const desired = await desiredRuntime(releaseId);

  const verdict = evaluateAdmission(
    {
      hasConfigReleaseCapability: releaseCapability,
      actual: { daemon_build: actual.daemon_build, catalog_fingerprint: actual.catalog_fingerprint },
      desiredCatalogFingerprint: desired.catalog_fingerprint ?? '',
    },
    deps.minDaemonBuild,
  );
  if (!verdict.admitted) deps.onRefused({ failedCheck: verdict.failedCheck, cause: verdict.cause });
  return verdict;
}
