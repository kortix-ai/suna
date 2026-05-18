/**
 * Snapshot content hash.
 *
 * One hash function, one purpose: given everything that affects what a
 * built sandbox image will contain, produce a stable digest. Identical
 * inputs → identical hash → the snapshot builder hits the cache and
 * skips a rebuild.
 *
 * Inputs (in this exact order — order matters, since the digest is over
 * a serialized blob):
 *
 *   1. Dockerfile bytes at the commit being built.
 *   2. Git tree OID of the build-context path at that commit.
 *      Git's own content-addressed hash of every file under the context
 *      gives us perfect change detection: COPY ./scripts/setup.sh in
 *      the Dockerfile is invalidated when the file changes, for free.
 *   3. Runtime fingerprint — opaque string we control. Bumping this
 *      forces every project to rebuild (e.g. when we ship a new
 *      kortix-agent binary or pin a new opencode CLI version).
 *
 * The output is a hex SHA-256 (64 chars). Snapshot names take the first
 * 12 chars to stay readable while keeping collision probability
 * negligible at any realistic project / commit count.
 */

import { createHash } from 'node:crypto';
import { SANDBOX_VERSION } from '../config';

export interface SnapshotHashInputs {
  /** UTF-8 contents of the user's Dockerfile at the build commit. */
  dockerfile: string;
  /** Git tree OID of `[sandbox] context` at the build commit. */
  contextTreeOid: string;
  /**
   * Override of the runtime fingerprint. Defaults to SANDBOX_VERSION
   * — the platform-wide constant that bumps on every Kortix release.
   * Tests pin this for determinism.
   */
  runtimeFingerprint?: string;
}

export interface SnapshotHashResult {
  /** Full SHA-256 hex (64 chars). Useful for logs / debug. */
  contentHash: string;
  /** First 12 chars of contentHash — what we slot into snapshot names. */
  shortHash: string;
  /** The fingerprint actually used, for telemetry / debug output. */
  runtimeFingerprint: string;
}

/**
 * Default runtime fingerprint. SANDBOX_VERSION is the platform-wide
 * release marker — bumping it invalidates every project's cache.
 */
export function currentRuntimeFingerprint(): string {
  return `kortix-runtime:${SANDBOX_VERSION}`;
}

export function computeSnapshotHash(inputs: SnapshotHashInputs): SnapshotHashResult {
  const runtimeFingerprint = inputs.runtimeFingerprint ?? currentRuntimeFingerprint();
  // Length-prefix each segment so adjacent fields can't collide via
  // concatenation. `dockerfile=42:<42 bytes>` is unambiguous; raw
  // concatenation of variable-length strings is not.
  const blob = [
    `dockerfile=${inputs.dockerfile.length}:${inputs.dockerfile}`,
    `tree_oid=${inputs.contextTreeOid}`,
    `runtime=${runtimeFingerprint}`,
  ].join('\n');

  const contentHash = createHash('sha256').update(blob).digest('hex');
  return {
    contentHash,
    shortHash: contentHash.slice(0, 12),
    runtimeFingerprint,
  };
}

/**
 * Format the Daytona snapshot name for a given project + content hash.
 * Daytona snapshot names are global per organization, so we prefix with
 * `kortix-snap-` to claim our namespace and embed the project id so
 * two projects with byte-identical Dockerfiles still get distinct
 * snapshots (avoids accidental cross-project sharing).
 */
export function formatSnapshotName(projectId: string, contentHash: string): string {
  const projectSlug = projectId.replace(/-/g, '').slice(0, 8);
  return `kortix-snap-${projectSlug}-${contentHash.slice(0, 12)}`;
}
