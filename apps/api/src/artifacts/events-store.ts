import { artifactEvents, driveCommitAuthors, type Database } from '@kortix/db';
import type { VolumeWriteCommit } from '../drives/volumes';
import { db } from '../shared/db';
import type { ArtifactRow } from './service';

export type ArtifactEventType = 'published' | 'renamed' | 'visibility_changed' | 'shared_with_changed' | 'restored'
  | 'thread_opened' | 'replied' | 'resolved' | 'reopened' | 'comment_deleted' | 'sent_to_agent';

type Writer = Pick<Database, 'insert'>;
export interface DriveCommitAuthor { userId?: string | null; sessionId?: string | null }

export async function recordArtifactEvent(
  tx: Writer,
  artifact: Pick<ArtifactRow, 'artifactId' | 'projectId'>,
  author: DriveCommitAuthor | null,
  type: ArtifactEventType,
  data: Record<string, unknown> = {},
): Promise<void> {
  await tx.insert(artifactEvents).values({
    artifactId: artifact.artifactId,
    projectId: artifact.projectId,
    type,
    actorUserId: author?.sessionId ? null : author?.userId ?? null,
    actorSessionId: author?.sessionId ?? null,
    data,
  });
}

export async function recordDriveCommitAuthor(
  driveId: string,
  commit: VolumeWriteCommit | undefined,
  author: DriveCommitAuthor,
  tx: Writer = db,
): Promise<void> {
  if (!commit || commit.outcome === 'noop') return;
  if (!author.sessionId && !author.userId) throw new Error('A Files commit author needs a user or session');
  await tx.insert(driveCommitAuthors).values({
    driveId,
    commitId: commit.commit_id,
    authorUserId: author.sessionId ? null : author.userId!,
    authorSessionId: author.sessionId ?? null,
  }).onConflictDoNothing();
}
