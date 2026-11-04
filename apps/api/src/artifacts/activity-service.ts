import { artifactEvents, driveCommitAuthors, projectSessions, sessionSandboxIdentities, sessionSandboxes } from '@kortix/db';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { getDrive, readDriveVolume } from '../drives/service';
import { DriveStorageError, listVolumeCommits, statVolumeFile, type VolumeCommit } from '../drives/volumes';
import { resolveUserIdentities } from '../projects/surface';
import { db } from '../shared/db';
import { ArtifactError, entryPath, type ArtifactRow } from './service';
import { activityCursor, activityInstant, activityLimit, activityMicros, compareActivity, readActivityCursor, type ActivityKey } from './activity-query';

interface ActivityRow extends ActivityKey {
  type: string;
  userId: string | null;
  sessionId: string | null;
  data: Record<string, unknown>;
}

async function savedActivity(artifact: ArtifactRow): Promise<{ items: ActivityRow[]; older: boolean }> {
  const drive = await getDrive(artifact.driveId);
  if (!drive) throw new ArtifactError(404, 'Files not found', 'not_found');
  const history = await readDriveVolume(drive, async (volume) => {
    const commits = await listVolumeCommits(volume, 100);
    const candidates = commits.filter((commit) => commit.on_head !== false && commit.kind !== 'init');
    const versions = new Map<string, Promise<string | null>>();
    const path = entryPath(artifact);
    const version = (id: string): Promise<string | null> => {
      if (!versions.has(id)) versions.set(id, statVolumeFile(volume, path, id).then((stat) => stat.version).catch((error) => {
        if (error instanceof DriveStorageError && error.status === 404) return null;
        throw error;
      }));
      return versions.get(id)!;
    };
    const saves: VolumeCommit[] = [];
    for (let i = 0; i < candidates.length; i += 8) {
      const batch = await Promise.all(candidates.slice(i, i + 8).map(async (commit) => {
        const base = commit.parent_id;
        const [after, before] = await Promise.all([version(commit.id), base ? version(base) : null]);
        return after !== before ? commit : null;
      }));
      saves.push(...batch.filter((commit): commit is VolumeCommit => commit !== null));
    }
    const sourceIds = [...new Set(saves.flatMap((commit) => commit.kind === 'merge' && commit.merged_from?.length === 1 ? commit.merged_from : []))];
    const sources: VolumeCommit[] = [];
    for (let i = 0; i < sourceIds.length; i += 8) {
      const { getVolumeCommit } = await import('../drives/volumes');
      const batch = await Promise.all(sourceIds.slice(i, i + 8).map((id) => getVolumeCommit(volume, id).catch((error) => {
        if (error instanceof DriveStorageError && error.status === 404) return null;
        throw error;
      })));
      sources.push(...batch.filter((commit): commit is VolumeCommit => commit !== null));
    }
    return { saves, commits: [...commits, ...sources], older: commits.length === 100 };
  }, () => ({ saves: [] as VolumeCommit[], commits: [] as VolumeCommit[], older: false }));
  if (!history.saves.length) return { items: [], older: history.older };
  const receipts = await db.select().from(driveCommitAuthors).where(and(
    eq(driveCommitAuthors.driveId, drive.driveId), inArray(driveCommitAuthors.commitId,
      history.saves.flatMap((commit) => [commit.id, ...(commit.merged_from ?? [])])),
  ));
  const authors = new Map(receipts.map((receipt) => [receipt.commitId, { userId: receipt.authorUserId, sessionId: receipt.authorSessionId }]));
  const byId = new Map(history.commits.map((commit) => [commit.id, commit]));
  const source = (commit: VolumeCommit) => commit.kind === 'merge' && commit.merged_from?.length === 1 ? byId.get(commit.merged_from[0]!) : commit;
  const externalIds = [...new Set(history.saves.flatMap((commit) => {
    const writer = source(commit);
    return writer?.author.kind === 'sandbox' && writer.author.id ? [writer.author.id] : [];
  }))];
  const sessions = new Map<string, string>();
  if (externalIds.length) {
    const [durable, current] = await Promise.all([
      db.select().from(sessionSandboxIdentities).where(and(eq(sessionSandboxIdentities.accountId, drive.accountId),
        eq(sessionSandboxIdentities.projectId, artifact.projectId), eq(sessionSandboxIdentities.provider, 'platinum'), inArray(sessionSandboxIdentities.externalId, externalIds))),
      db.select({ externalId: sessionSandboxes.externalId, sessionId: sessionSandboxes.sessionId }).from(sessionSandboxes)
        .innerJoin(projectSessions, and(eq(projectSessions.sessionId, sessionSandboxes.sessionId), eq(projectSessions.accountId, sessionSandboxes.accountId), eq(projectSessions.projectId, sessionSandboxes.projectId)))
        .where(and(eq(sessionSandboxes.accountId, drive.accountId), eq(sessionSandboxes.projectId, artifact.projectId), eq(sessionSandboxes.provider, 'platinum'), inArray(sessionSandboxes.externalId, externalIds))),
    ]);
    for (const row of current) if (row.externalId) sessions.set(row.externalId, row.sessionId);
    for (const row of durable) sessions.set(row.externalId, row.sessionId);
  }
  return {
    older: history.older,
    items: history.saves.map((commit) => {
      const writer = source(commit);
      const sourceId = commit.kind === 'merge' && commit.merged_from?.length === 1 ? commit.merged_from[0]! : commit.id;
      return {
        id: `save:${commit.id}`, us: activityMicros(commit.created_at), type: 'saved',
        ...(authors.get(sourceId) ?? { userId: null, sessionId: writer?.author.kind === 'sandbox' && writer.author.id ? sessions.get(writer.author.id) ?? null : null }),
        data: { commit_id: commit.id, version: commit.id, kind: commit.kind,
          ...(commit.kind === 'merge' ? { contributors: commit.merged_from ?? [], ...(sourceId !== commit.id ? { source_commit_id: sourceId } : {}) } : {}),
        },
      };
    }),
  };
}

export async function readArtifactActivity(artifact: ArtifactRow, query: { limit?: string; cursor?: string }) {
  const limit = activityLimit(query.limit);
  const cursor = readActivityCursor(artifact.artifactId, query.cursor);
  const [events, saves] = await Promise.all([
    db.select({ id: artifactEvents.eventId, type: artifactEvents.type, userId: artifactEvents.actorUserId, sessionId: artifactEvents.actorSessionId,
      data: artifactEvents.data, us: sql<string>`(extract(epoch from ${artifactEvents.createdAt}) * 1000000)::bigint` })
      .from(artifactEvents).where(and(eq(artifactEvents.artifactId, artifact.artifactId), cursor
        ? sql`(${artifactEvents.createdAt}, 'event:' || ${artifactEvents.eventId}::text) < (${activityInstant(cursor.us)}::timestamptz, ${cursor.id})` : undefined))
      .orderBy(desc(artifactEvents.createdAt), desc(artifactEvents.eventId)).limit(limit + 1),
    savedActivity(artifact),
  ]);
  const merged: ActivityRow[] = [...events.map((event) => ({ ...event, id: `event:${event.id}`, us: Number(event.us) })), ...saves.items]
    .filter((item) => !cursor || compareActivity(item, cursor) > 0).sort(compareActivity);
  const page = merged.slice(0, limit);
  const userIds = page.flatMap((item) => item.userId ? [item.userId] : []);
  const sessionIds = [...new Set(page.flatMap((item) => item.sessionId ? [item.sessionId] : []))];
  const [users, sessionRows] = await Promise.all([
    resolveUserIdentities(userIds),
    sessionIds.length ? db.select({ id: projectSessions.sessionId, name: projectSessions.agentName, metadata: projectSessions.metadata }).from(projectSessions)
      .where(and(eq(projectSessions.accountId, artifact.accountId), eq(projectSessions.projectId, artifact.projectId), inArray(projectSessions.sessionId, sessionIds))) : [],
  ]);
  const sessions = new Map(sessionRows.map((session) => {
    const metadata = session.metadata as Record<string, unknown> | null;
    const title = [metadata?.custom_name, metadata?.name].find((value): value is string => typeof value === 'string' && !!value.trim());
    return [session.id, title ? `${session.name} · ${title}` : session.name];
  }));
  return {
    items: page.map((item) => ({ id: item.id, type: item.type, at: activityInstant(item.us), data: item.data,
      actor: item.sessionId ? { kind: 'session' as const, id: item.sessionId, name: sessions.get(item.sessionId) ?? 'Agent session' }
        : item.userId ? { kind: 'user' as const, id: item.userId, name: users.get(item.userId)?.displayName || users.get(item.userId)?.email || 'Former user' }
          : { kind: 'system' as const, id: null, name: 'System' },
    })),
    next_cursor: merged.length > limit ? activityCursor(artifact.artifactId, page[page.length - 1]!) : null,
    older_versions: saves.older,
  };
}
