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
 *   3. Runtime fingerprint — opaque string we control. The snapshot builder
 *      normally derives this from SANDBOX_VERSION plus the runtime artifact
 *      bytes copied into the image (kortix-agent, entrypoint, CLI files).
 *   4. Hardware spec — the `[sandbox]` cpu/memory/disk/gpu, baked into the
 *      snapshot at build time. Only mixed in when at least one field is set,
 *      so projects that don't declare a spec keep their existing hashes (no
 *      mass rebuild when this field rolls out).
 *
 * The output is a hex SHA-256 (64 chars). Snapshot names take the first
 * 12 chars to stay readable while keeping collision probability
 * negligible at any realistic project / commit count.
 */

import { createHash } from 'node:crypto';
import { SANDBOX_VERSION } from '../config';
import type { SandboxSpec } from './dockerfile-layer';

export interface SnapshotHashInputs {
  /** UTF-8 contents of the user's Dockerfile at the build commit. */
  dockerfile: string;
  /** Git tree OID of `[sandbox] context` at the build commit. */
  contextTreeOid: string;
  /**
   * Hardware spec from `[sandbox]`. Baked into the snapshot, so it's part
   * of the identity: change cpu/memory/disk/gpu, rebuild. Omitted from the
   * digest entirely when empty so unspecced projects keep their hashes.
   */
  spec?: SandboxSpec;
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
 * release marker. The snapshot builder overrides this with a richer
 * artifact fingerprint; tests use this default for deterministic hashing.
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
  ];
  // Only append the spec segment when something is actually set, so a
  // manifest without `[sandbox]` resources hashes identically to before
  // this field existed — no surprise rebuild of every project's snapshot.
  const specSegment = serializeSpec(inputs.spec);
  if (specSegment) blob.push(`spec=${specSegment}`);

  const contentHash = createHash('sha256').update(blob.join('\n')).digest('hex');
  return {
    contentHash,
    shortHash: contentHash.slice(0, 12),
    runtimeFingerprint,
  };
}

/**
 * Canonical serialization of a sandbox spec for the content hash. Fixed
 * key order, only present fields, e.g. `cpu:2,memory:4,disk:20`. Returns
 * an empty string when nothing is set (the no-spec, no-rebuild case).
 */
function serializeSpec(spec?: SandboxSpec): string {
  if (!spec) return '';
  const parts: string[] = [];
  if (spec.cpu !== undefined) parts.push(`cpu:${spec.cpu}`);
  if (spec.memory !== undefined) parts.push(`memory:${spec.memory}`);
  if (spec.disk !== undefined) parts.push(`disk:${spec.disk}`);
  if (spec.gpu !== undefined) parts.push(`gpu:${spec.gpu}`);
  return parts.join(',');
}

/**
 * Format the Daytona snapshot name for a given content hash. Snapshot names
 * are *globally* content-addressed under the `kortix-snap-` namespace, so two
 * projects with byte-identical inputs share one Daytona image — a new project
 * cloned off an existing starter hits the cache instead of paying for a fresh
 * build (and instead of consuming a slot of the 100/org snapshot quota).
 *
 * Safe to share because the image carries no per-project identity: the inputs
 * (Dockerfile + git tree + runtime fingerprint + spec) are pure source bytes;
 * secrets are injected at sandbox boot, not baked into the image.
 *
 * The `_projectId` argument is retained for callers that previously needed it
 * (and may want it back if we ever re-tier the namespace), but it is currently
 * ignored.
 */
export function formatSnapshotName(_projectId: string, contentHash: string): string {
  return `kortix-snap-${contentHash.slice(0, 12)}`;
}
