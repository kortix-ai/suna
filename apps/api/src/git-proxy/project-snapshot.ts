/**
 * Project snapshot archives — the producer side of the S3 config provider.
 *
 * A snapshot is the committed project tree at ONE exact commit, plus a
 * sanitized shallow `.git` (one commit, no remotes, no hooks, no reflogs),
 * packed as `.tar.gz` and published to object storage under an immutable,
 * revision-addressed prefix (see project-snapshot-store.ts). A fresh session
 * downloads it through a short-lived descriptor instead of cloning through the
 * Git proxy.
 *
 * Three concerns live here, deliberately in one small module:
 *   - the readiness LEDGER (`kortix.project_snapshot_archives`): one row per
 *     (project, sha); `queued` → `building` → `ready` | `failed`;
 *   - ENQUEUE helpers used by every place the API learns a base tip
 *     (registration, proxy push, CR merge, session create);
 *   - the BUILD + PUBLISH step the leader worker runs for a claimed row.
 *
 * What the archive deliberately does NOT carry: credentials, credential-bearing
 * remotes, hooks, reflogs, untracked files, LFS objects (pointers only — the
 * Git path has the same semantics), submodule contents (`.gitmodules` only,
 * like a clone without `--recurse-submodules`).
 */
import { config } from '../lib/config';
import { validateRef } from '../services/git/git-ref';
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

// ── Repository identity ─────────────────────────────────────────────────────
export * from './project-snapshot-ledger';
export * from './project-snapshot-build';
export * from './project-snapshot-worker-operations';
