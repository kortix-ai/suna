/**
 * Shared primitives of the project snapshot producer: the consumption modes,
 * ref normalization, the extraction marker, and the pure snapshot types.
 *
 * Leaf module: it imports only the config, ref validation and the object
 * layout (`project-snapshot-store.ts`), and no snapshot module imports it
 * back. The implementation modules (`project-snapshot-ledger.ts`,
 * `project-snapshot-build.ts`, `project-snapshot-worker-operations.ts`) import
 * these directly instead of reaching through the `project-snapshot` barrel,
 * which re-exports them — that back-edge was a runtime import cycle.
 */
import { config } from '../config';
import { validateRef } from '../projects/git-ref';
import { PROJECT_SNAPSHOT_FORMAT, type ProjectSnapshotRepository } from './project-snapshot-store';

export const PROJECT_SNAPSHOT_MODES = ['git', 'prefer-s3', 'require-s3'] as const;
export type ProjectSnapshotMode = (typeof PROJECT_SNAPSHOT_MODES)[number];

/** Platform mode, overridable per project through `metadata.project_snapshot_mode` (the canary lever). */
export function resolveProjectSnapshotMode(projectMetadata: unknown): ProjectSnapshotMode {
  const override = (projectMetadata as { project_snapshot_mode?: unknown } | null)?.project_snapshot_mode;
  if (typeof override === 'string' && (PROJECT_SNAPSHOT_MODES as readonly string[]).includes(override)) {
    return override as ProjectSnapshotMode;
  }
  return config.KORTIX_PROJECT_SNAPSHOT_MODE;
}

/** `refs/heads/main` and `main` are one identity. */
export function normalizeSnapshotRef(ref: string): string {
  return validateRef(ref.trim().replace(/^refs\/heads\//, ''));
}

/** Marker the daemon reads after extraction to verify identity before activation. */
export const PROJECT_SNAPSHOT_MARKER_PATH = '.git/kortix-project-snapshot.json';

export interface ProjectSnapshotMarker {
  format: typeof PROJECT_SNAPSHOT_FORMAT;
  repository: { owner: string; name: string; external_id: string };
  ref: string;
  commit_sha: string;
}

export type ProjectSnapshotStatus = 'queued' | 'building' | 'ready' | 'failed';

export interface ReadyProjectSnapshot {
  snapshotId: string;
  projectId: string;
  ref: string;
  commitSha: string;
  repository: ProjectSnapshotRepository;
  objectPrefix: string;
  /** Boot object (working tree + blobless .git): digest, size, tar entries. */
  archiveSha256: string;
  archiveBytes: number;
  entryCount: number;
  /** Hydration object (the tip's blob pack). */
  blobsSha256: string;
  blobsBytes: number;
  readyAt: Date;
}
