/**
 * The project snapshot a v3 box builds a release from (the descriptor's
 * `snapshot`), when it cannot reuse its own `/workspace` checkout.
 *
 * The snapshot of a commit is the same tree the release is built from: the
 * producer (`git-proxy/project-snapshot-build.ts`) checks the commit out and
 * ships the working tree, plus a blobless `.git` the box drops. The box keeps
 * only the files the descriptor lists and verifies each one against its blob
 * ID, so the snapshot needs no trust of its own beyond the digest.
 *
 * Every snapshot is streamed to disk on both sides, so a release delivered
 * this way has no `MAX_CONFIG_ARCHIVE_BYTES` cap; the snapshot's own cap is
 * `KORTIX_PROJECT_SNAPSHOT_MAX_ARCHIVE_BYTES`.
 */
import { enqueueProjectSnapshot, readReadyProjectSnapshot } from '../git-proxy/project-snapshot-ledger';
import {
  presignProjectSnapshotDownload,
  projectSnapshotStorageConfigured,
  projectSnapshotTreeKey,
} from '../git-proxy/project-snapshot-store';
import { logger } from '../lib/logger';
import type { ConfigReleaseSnapshot } from './builder';

export interface ConfigReleaseSnapshotDeps {
  configured: () => boolean;
  readReady: typeof readReadyProjectSnapshot;
  enqueue: typeof enqueueProjectSnapshot;
  presign: typeof presignProjectSnapshotDownload;
}

const defaultDeps: ConfigReleaseSnapshotDeps = {
  configured: projectSnapshotStorageConfigured,
  readReady: readReadyProjectSnapshot,
  enqueue: enqueueProjectSnapshot,
  presign: presignProjectSnapshotDownload,
};

/**
 * The ready snapshot of `commit`, presigned for one download, or null. A
 * commit with no ready snapshot is queued, so the box's next convergence
 * (at most a minute later) finds it. Never throws: the snapshot is one of the
 * box's sources, and a failure here leaves it the others.
 */
export async function configReleaseSnapshot(
  project: { projectId: string; repoUrl: string },
  ref: string,
  commit: string,
  deps: ConfigReleaseSnapshotDeps = defaultDeps,
): Promise<ConfigReleaseSnapshot | null> {
  if (!deps.configured()) return null;
  try {
    const ready = await deps.readReady(project.projectId, commit);
    if (!ready) {
      await deps.enqueue({ projectId: project.projectId, ref, commitSha: commit, repoUrl: project.repoUrl });
      return null;
    }
    const signed = await deps.presign(projectSnapshotTreeKey(ready.objectPrefix, ready.archiveSha256));
    return {
      url: signed.url,
      sha256: ready.archiveSha256,
      bytes: ready.archiveBytes,
      entries: ready.entryCount,
      expires_at: signed.expiresAt.toISOString(),
    };
  } catch (error) {
    logger.warn('[config-releases] snapshot lookup failed', {
      projectId: project.projectId,
      commit,
      error: (error as Error).message,
    });
    return null;
  }
}
