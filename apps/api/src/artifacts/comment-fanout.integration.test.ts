import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { artifactComments, artifactCommentThreads, artifactEvents, artifacts, drives, jobQueue, projectSessions, sessionLifecycleCommands } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { seedProject, seedSession, removeSeeded, type SeededProject } from '../__tests__/helpers/integration-fixtures';
import type { Actor } from '../iam/actor';
import { db } from '../shared/db';
import { config } from '../config';

const failures = new Map<string, Error>();
let currentBinding: string | null = null;
const volumes = await import('../drives/volumes');
mock.module('../drives/volumes', () => ({ ...volumes, statVolumeFile: async () => ({ version: 'fanout-entry-etag' }) }));
mock.module('./comment-authority', () => ({
  ArtifactCommentAuthorityError: class extends Error { name = 'ArtifactCommentAuthorityError'; },
  authorizeArtifactCommentAgent: async (actor: Actor, _project: unknown, agentName: string, session?: unknown) => {
    const failure = failures.get(agentName);
    if (failure) throw failure;
    return { actor, agentName, canPromptExisting: !!session, callerSessionId: currentBinding };
  },
  assertArtifactCommentDeliveryAccess: async () => {},
}));
const { enqueueArtifactCommentRouting, runArtifactCommentAgentJob, sendArtifactCommentThreads } = await import('./comment-delivery');

describe.skipIf(!process.env.TEST_DATABASE_URL)('Artifact comment fanout isolation', () => {
  const seeded: SeededProject[] = [];
  let project: SeededProject;
  let artifact: typeof artifacts.$inferSelect;
  let actor: Actor;
  let sessionId: string;
  const storageKey = config.PLATINUM_API_KEY;

  beforeEach(async () => {
    failures.clear();
    currentBinding = null;
    config.PLATINUM_API_KEY = 'synthetic-fanout-storage';
    project = await seedProject(`comment-fanout-${crypto.randomUUID()}`, { metadata: { experimental: { artifacts: true, artifact_comments: true } } });
    seeded.push(project);
    actor = { accountId: project.account_id, userId: crypto.randomUUID(), credential: { kind: 'jwt' }, ctx: {} };
    sessionId = await seedSession(project, actor.userId);
    await db.update(projectSessions).set({ agentName: 'writer' }).where(eq(projectSessions.sessionId, sessionId));
    const [drive] = await db.insert(drives).values({ accountId: actor.accountId, projectId: project.project_id, kind: 'project',
      name: 'Synthetic fanout Files', platinumVolumeName: `fanout-${crypto.randomUUID()}`, platinumVolumeId: `synthetic-${crypto.randomUUID()}` }).returning();
    [artifact] = await db.insert(artifacts).values({ accountId: actor.accountId, projectId: project.project_id, driveId: drive!.driveId,
      root: '/report', entry: 'index.md', folder: true, type: 'doc', title: 'Synthetic fanout', visibility: 'project', createdByUserId: actor.userId }).returning() as [typeof artifacts.$inferSelect];
  });
  afterAll(async () => { config.PLATINUM_API_KEY = storageKey; await removeSeeded(seeded); });

  async function claimedJob() {
    const [thread] = await db.insert(artifactCommentThreads).values({ artifactId: artifact.artifactId, projectId: artifact.projectId,
      anchor: { type: 'none', version: 'fanout-anchor' }, anchorVersion: 'fanout-anchor', createdByUserId: actor.userId }).returning();
    const [comment] = await db.insert(artifactComments).values({ threadId: thread!.threadId, body: '@researcher @writer review both concerns.', authorUserId: actor.userId,
      mentions: [{ kind: 'agent', agent_name: 'researcher' }, { kind: 'session', session_id: sessionId, agent_name: 'writer' }] }).returning();
    const key = await db.transaction((tx) => enqueueArtifactCommentRouting(tx, artifact, actor, null, thread!.threadId, comment!.commentId, false));
    const [job] = await db.update(jobQueue).set({ attempts: 1 }).where(and(eq(jobQueue.queue, 'artifact-comment-agents'), eq(jobQueue.jobKey, key))).returning();
    return job!;
  }
  const commands = () => db.select().from(sessionLifecycleCommands).where(eq(sessionLifecycleCommands.artifactId, artifact.artifactId));
  const events = () => db.select().from(artifactEvents).where(and(eq(artifactEvents.artifactId, artifact.artifactId), eq(artifactEvents.type, 'sent_to_agent')));

  test('one denied recipient does not discard another recipient and retries do not duplicate its prompt', async () => {
    failures.set('researcher', Object.assign(new Error('Synthetic denied recipient'), { name: 'ArtifactCommentAuthorityError' }));
    const job = await claimedJob();
    await expect(runArtifactCommentAgentJob(job)).rejects.toThrow();
    const rows = await commands();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessionId, commandType: 'continue_session' });
    const [stored] = await db.select().from(jobQueue).where(eq(jobQueue.jobId, job.jobId));
    expect(stored!.payload.targets).toMatchObject([{ agentName: 'researcher', status: 'failed' }, { agentName: 'writer', status: 'sent' }]);
    await expect(runArtifactCommentAgentJob(stored!)).rejects.toThrow();
    expect(await commands()).toHaveLength(1);
    expect(await events()).toHaveLength(1);
  });

  test('retryable authorization leaves one stable reservation and still delivers the other recipient', async () => {
    failures.set('researcher', new Error('Synthetic temporary authority failure'));
    const job = await claimedJob();
    await expect(runArtifactCommentAgentJob(job)).rejects.toThrow();
    expect(await commands()).toMatchObject([{ sessionId, commandType: 'continue_session' }]);
    const [first] = await db.select().from(jobQueue).where(eq(jobQueue.jobId, job.jobId));
    const pending = (first!.payload.targets as Array<{ sessionId: string; key: string; status: string }>)[0]!;
    expect(pending.status).toBe('pending');
    failures.clear();
    await expect(runArtifactCommentAgentJob(first!)).rejects.toThrow('still being created');
    const [retried] = await db.select().from(jobQueue).where(eq(jobQueue.jobId, job.jobId));
    expect((retried!.payload.targets as Array<Record<string, unknown>>)[0]).toMatchObject({ sessionId: pending.sessionId, key: pending.key, status: 'pending', initialized: true });
    expect((await commands()).filter((command) => command.commandType === 'continue_session')).toHaveLength(1);
    expect((await commands()).filter((command) => command.commandType === 'create_session')).toHaveLength(1);
    expect(await events()).toHaveLength(1);
  });

  test('a pending new session does not starve a ready existing recipient across retries', async () => {
    const job = await claimedJob();
    await expect(runArtifactCommentAgentJob(job)).rejects.toThrow('still being created');
    const rows = await commands();
    expect(rows.filter((command) => command.commandType === 'continue_session')).toMatchObject([{ sessionId }]);
    expect(rows.filter((command) => command.commandType === 'create_session')).toHaveLength(1);
    const [stored] = await db.select().from(jobQueue).where(eq(jobQueue.jobId, job.jobId));
    await expect(runArtifactCommentAgentJob(stored!)).rejects.toThrow('still being created');
    expect(await commands()).toHaveLength(2);
    expect(await events()).toHaveLength(1);
  });

  test('a valid recipient stops waiting on a different thread whose original mention was removed', async () => {
    const first = await claimedJob();
    await expect(runArtifactCommentAgentJob(first)).rejects.toThrow('still being created');
    const second = await claimedJob();
    await expect(runArtifactCommentAgentJob(second)).rejects.toThrow('still being created');
    const [waiting] = await db.select().from(jobQueue).where(eq(jobQueue.jobId, second.jobId));
    const reservation = (waiting!.payload.targets as Array<{ sessionId: string; createKey?: string }>)[0]!;
    const originalSessionId = reservation.sessionId;
    expect(reservation.createKey).toBe(first.jobKey);
    expect((await commands()).filter((command) => command.commandType === 'create_session')).toHaveLength(1);
    await db.update(artifactComments).set({ mentions: [{ kind: 'session', session_id: sessionId, agent_name: 'writer' }] })
      .where(eq(artifactComments.commentId, first.payload.commentId as string));
    await expect(runArtifactCommentAgentJob(waiting!)).rejects.toThrow('still being created');
    const [independent] = await db.select().from(jobQueue).where(eq(jobQueue.jobId, second.jobId));
    const target = (independent!.payload.targets as Array<{ sessionId: string; created: boolean; createKey?: string }>)[0]!;
    expect(target.created).toBe(true);
    expect(target.createKey).toBeUndefined();
    expect(target.sessionId).not.toBe(originalSessionId);
    expect((await commands()).filter((command) => command.commandType === 'create_session')).toHaveLength(2);
    expect((await commands()).filter((command) => command.commandType === 'continue_session')).toHaveLength(2);
  });

  test('dispatch rejects a changed legacy PAT binding before creating any lifecycle command', async () => {
    actor.credential = { kind: 'pat', tokenId: crypto.randomUUID(), projectId: artifact.projectId };
    const job = await claimedJob();
    currentBinding = sessionId;
    await expect(runArtifactCommentAgentJob(job)).rejects.toThrow();
    expect(await commands()).toEqual([]);
    expect(await events()).toEqual([]);
    const [stored] = await db.select().from(jobQueue).where(eq(jobQueue.jobId, job.jobId));
    expect((stored!.payload.targets as Array<{ status: string }>).every((target) => target.status === 'failed')).toBe(true);
  });

  test('manual Send retries reject a changed legacy PAT binding without another handoff', async () => {
    actor.credential = { kind: 'pat', tokenId: crypto.randomUUID(), projectId: artifact.projectId };
    const source = await claimedJob();
    await db.update(artifacts).set({ createdBySessionId: sessionId }).where(eq(artifacts.artifactId, artifact.artifactId));
    artifact.createdBySessionId = sessionId;
    const input = { thread_ids: source.payload.threadIds as string[], batch_id: crypto.randomUUID(), agent: 'writer' };
    expect(await sendArtifactCommentThreads(artifact, actor, null, input)).toEqual({ session_id: sessionId, created: false });
    currentBinding = sessionId;
    await expect(sendArtifactCommentThreads(artifact, actor, null, input)).rejects.toMatchObject({ name: 'ArtifactCommentAuthorityError' });
    expect(await commands()).toHaveLength(1);
    expect(await events()).toHaveLength(1);
  });
});
