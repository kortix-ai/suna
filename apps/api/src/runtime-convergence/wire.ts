/**
 * The `runtime` block of `GET /v1/projects/:projectId/sessions/:sessionId/config`
 * (spec §3, the runtime-convergence contract (PR #7785)): "one runtime block… listing
 * desired vs actual per component with each component's last attempt and
 * cause." The session header chip reads `overall`. The existing `release`
 * block is untouched — this is purely additive.
 */

import type { DesiredRuntimeDocument } from './desired';
import type { RuntimeDiff, RuntimeOverallState, RuntimeComponentDiff } from './diff';

/** The box's actual document, flattened to the same five fields `desired`
 *  carries — but nullable: `null` means the box did not report that field,
 *  never coerced to look like a match. */
export interface RuntimeBlockActualWire {
  release_id: string | null;
  catalog_fingerprint: string | null;
  daemon_build: string | number | null;
  cli_sha256: string | null;
  managed_skills_hash: string | null;
}

export interface RuntimeBlockWire {
  overall: RuntimeOverallState;
  /** Set only when `overall === 'unknown'` — the reason the API can prove (e.g. `runtime_truth_not_reported`), for the chip to render instead of a bare state name. */
  overall_reason: string | null;
  desired: DesiredRuntimeDocument;
  actual: RuntimeBlockActualWire;
  components: RuntimeComponentDiff[];
}

export function toRuntimeBlockWire(diff: RuntimeDiff): RuntimeBlockWire {
  return {
    overall: diff.overall,
    overall_reason: diff.overall_reason,
    desired: diff.desired,
    actual: {
      release_id: diff.actual.release_id,
      catalog_fingerprint: diff.actual.catalog_fingerprint,
      daemon_build: diff.actual.daemon_build,
      cli_sha256: diff.actual.cli_sha256,
      managed_skills_hash: diff.actual.managed_skills_hash,
    },
    components: diff.components,
  };
}
