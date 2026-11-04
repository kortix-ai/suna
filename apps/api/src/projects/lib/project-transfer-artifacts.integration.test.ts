import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import { accountMemberships, accounts, artifactComments, artifactCommentThreads, artifactEvents, artifacts, driveCommitAuthors, drives, iamRoles, jobQueue,
  projects, projectSessions, roleAssignments, sessionLifecycleCommands, sessionSandboxes, sessionSandboxIdentities } from '@kortix/db';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../shared/db';
import { seedProject, seedSession, removeSeeded, type SeededProject } from '../../__tests__/helpers/integration-fixtures';
import { config } from '../../config';
import { authorize } from '../../iam/authorize';

const volumeApi = await import('../../drives/volumes');
const storageKey = config.PLATINUM_API_KEY;
const externalId = `sbx_owned_${crypto.randomUUID()}`;
mock.module('../../drives/volumes', () => ({ ...volumeApi,
  listVolumeCommits: async () => [
    { id: 'sandbox-save', kind: 'write', author: { kind: 'sandbox', id: externalId }, parent_id: 'api-save', created_at: '2026-10-29T12:00:01Z' },
    { id: 'api-save', kind: 'write', author: { kind: 'api_key', id: 'synthetic-key' }, parent_id: null, created_at: '2026-10-29T12:00:00Z' },
  ],
  statVolumeFile: async (_volume: string, _path: string, at: string) => ({ version: at === 'api-save' ? 'etag-one' : 'etag-two' }),
}));
const { transferProjectOwnership } = await import('./project-transfer');
const { getArtifact } = await import('../../artifacts/service');
const { createArtifactCommentThread, listArtifactCommentThreads } = await import('../../artifacts/comments-service');
const { readArtifactActivity } = await import('../../artifacts/activity-service');
const sourceOwner = crypto.randomUUID();
const targetOwner = crypto.randomUUID();
const targetAccount = crypto.randomUUID();
let project: SeededProject;
let artifact: typeof artifacts.$inferSelect;
let sessionId: string;
let pendingThread: typeof artifactCommentThreads.$inferSelect;
let deliveredThread: typeof artifactCommentThreads.$inferSelect;
let pendingJob: typeof jobQueue.$inferSelect;
let pendingCommand: typeof sessionLifecycleCommands.$inferSelect;
let loopThread: typeof artifactCommentThreads.$inferSelect;
let queuedThread: typeof artifactCommentThreads.$inferSelect;
let protectedJob: typeof jobQueue.$inferSelect;
let completedCommand: typeof sessionLifecycleCommands.$inferSelect;
let unscopedCommand: typeof sessionLifecycleCommands.$inferSelect;

beforeAll(async () => {
  config.PLATINUM_API_KEY = 'synthetic-transfer-storage';
  project = await seedProject(`transfer-artifacts-${crypto.randomUUID()}`, { metadata: { experimental: { artifacts: true, artifact_comments: true } } });
  await db.insert(accounts).values({ accountId: targetAccount, name: 'Artifact transfer destination' });
  const [owner] = await db.select().from(iamRoles).where(and(isNull(iamRoles.accountId), eq(iamRoles.key, 'owner'), eq(iamRoles.scopeType, 'account')));
  for (const [userId, accountId] of [[sourceOwner, project.account_id], [targetOwner, targetAccount]]) {
    await db.insert(accountMemberships).values({ userId, accountId });
    await db.insert(roleAssignments).values({ accountId, principalType: 'user', principalId: userId, roleId: owner!.roleId, scopeType: 'account' });
  }
  sessionId = await seedSession(project, sourceOwner);
  await db.update(projectSessions).set({ agentName: 'writer', metadata: { name: 'Transferred writer' } }).where(eq(projectSessions.sessionId, sessionId));
  const [drive] = await db.insert(drives).values({ accountId: project.account_id, projectId: project.project_id, kind: 'project', name: 'Transferred Files',
    platinumVolumeName: `transfer-${crypto.randomUUID()}`, platinumVolumeId: 'synthetic-provider-volume' }).returning();
  [artifact] = await db.insert(artifacts).values({ accountId: project.account_id, projectId: project.project_id, driveId: drive!.driveId,
    root: '/transfer', entry: 'index.md', folder: true, type: 'doc', title: 'Transferred report', visibility: 'project', createdByUserId: sourceOwner }).returning() as [typeof artifacts.$inferSelect];
  const threads = await db.insert(artifactCommentThreads).values(['pending', 'sent'].map((agentState) => ({ artifactId: artifact.artifactId,
    projectId: artifact.projectId, createdBySessionId: sessionId, anchor: { type: 'none', version: 'api-save' }, anchorVersion: 'api-save', agentState: agentState as 'pending' | 'sent' }))).returning();
  [pendingThread, deliveredThread] = threads as [typeof pendingThread, typeof deliveredThread];
  for (const thread of threads) await db.insert(artifactComments).values({ threadId: thread.threadId, authorSessionId: sessionId, body: 'Retained Artifact feedback.' });
  await db.insert(artifactEvents).values({ artifactId: artifact.artifactId, projectId: artifact.projectId, type: 'thread_opened', actorSessionId: sessionId, data: { thread_id: deliveredThread.threadId } });
  await db.insert(driveCommitAuthors).values({ driveId: drive!.driveId, commitId: 'api-save', authorSessionId: sessionId });
  await db.insert(sessionSandboxIdentities).values({ accountId: project.account_id, projectId: project.project_id, sessionId, provider: 'platinum', externalId });
  await db.insert(sessionSandboxes).values({ sandboxId: crypto.randomUUID(), accountId: project.account_id, projectId: project.project_id, sessionId, provider: 'platinum', externalId: `sbx_live_${crypto.randomUUID()}`, status: 'active' });
  [pendingJob] = await db.insert(jobQueue).values({ queue: 'artifact-comment-agents', artifactId: artifact.artifactId, jobKey: `transfer:${crypto.randomUUID()}`,
    payload: { artifactId: artifact.artifactId, actor: { accountId: project.account_id, userId: sourceOwner }, threadIds: [pendingThread.threadId] } }).returning() as [typeof pendingJob];
  [pendingCommand] = await db.insert(sessionLifecycleCommands).values({ commandType: 'continue_session', source: 'system:artifact-comment', status: 'queued',
    accountId: project.account_id, projectId: project.project_id, sessionId, artifactId: artifact.artifactId, actorUserId: sourceOwner,
    idempotencyKey: `transfer-command:${crypto.randomUUID()}`, payload: { text: 'Captured feedback.', artifactCommentDelivery: { job_id: pendingJob.jobId, target_key: pendingJob.jobKey } } }).returning() as [typeof pendingCommand];
  const extra = await db.insert(artifactCommentThreads).values([{ artifactId: artifact.artifactId, projectId: artifact.projectId,
    createdBySessionId: sessionId, anchor: { type: 'none', version: 'api-save' }, anchorVersion: 'api-save', agentState: 'paused', agentError: null },
  { artifactId: artifact.artifactId, projectId: artifact.projectId, createdBySessionId: sessionId, anchor: { type: 'none', version: 'api-save' }, anchorVersion: 'api-save', agentState: 'sent' }]).returning();
  [loopThread, queuedThread] = extra as [typeof loopThread, typeof queuedThread];
  for (const thread of extra) await db.insert(artifactComments).values({ threadId: thread.threadId, authorSessionId: sessionId, body: 'Retained additional feedback.' });
  await db.insert(jobQueue).values({ queue: 'artifact-comment-agents', artifactId: artifact.artifactId, jobKey: `loop:${crypto.randomUUID()}`,
    payload: { threadIds: [loopThread.threadId] } });
  const [done] = await db.insert(jobQueue).values({ queue: 'artifact-comment-agents', artifactId: artifact.artifactId, jobKey: `done:${crypto.randomUUID()}`,
    status: 'done', payload: { threadIds: [queuedThread.threadId] } }).returning();
  await db.insert(sessionLifecycleCommands).values({ commandType: 'create_session', source: 'system:artifact-comment', status: 'running',
    accountId: project.account_id, projectId: project.project_id, artifactId: artifact.artifactId, actorUserId: sourceOwner,
    payload: { metadata: { artifactCommentDelivery: { job_id: done!.jobId, target_key: done!.jobKey } } } });
  [protectedJob] = await db.insert(jobQueue).values({ queue: 'unrelated-owned-test', artifactId: artifact.artifactId, jobKey: `other:${crypto.randomUUID()}`, payload: {} }).returning() as [typeof protectedJob];
  [completedCommand, unscopedCommand] = await db.insert(sessionLifecycleCommands).values([
    { commandType: 'continue_session', source: 'system:artifact-comment', status: 'succeeded', accountId: project.account_id,
      projectId: project.project_id, artifactId: artifact.artifactId, sessionId, actorUserId: sourceOwner, payload: { text: 'Already delivered history.' } },
    { commandType: 'continue_session', source: 'unrelated-owned-test', status: 'queued', accountId: project.account_id,
      projectId: project.project_id, sessionId, actorUserId: sourceOwner, payload: { text: 'Another feature owns this.' } },
  ]).returning() as [typeof completedCommand, typeof unscopedCommand];
});
afterAll(async () => { config.PLATINUM_API_KEY = storageKey; await removeSeeded([project]); await db.delete(accounts).where(eq(accounts.accountId, targetAccount)); });

test('transfer moves Files authorship, retains readable comments/activity, and cancels only pending old-tenant delivery', async () => {
  await transferProjectOwnership({ projectId: project.project_id, fromAccountId: project.account_id, toAccountId: targetAccount });
  expect(await db.select().from(sessionSandboxIdentities).where(eq(sessionSandboxIdentities.externalId, externalId))).toMatchObject([{ accountId: targetAccount, projectId: project.project_id, sessionId }]);
  expect(await db.select().from(sessionSandboxIdentities).where(eq(sessionSandboxIdentities.projectId, project.project_id))).toHaveLength(2);
  expect(await db.select().from(sessionSandboxIdentities).where(and(eq(sessionSandboxIdentities.projectId, project.project_id), eq(sessionSandboxIdentities.accountId, project.account_id)))).toHaveLength(0);
  const moved = await getArtifact(project.project_id, artifact.artifactId);
  expect(moved?.accountId).toBe(targetAccount);
  const targetActor = { userId: targetOwner, accountId: targetAccount, credential: { kind: 'jwt' as const }, ctx: {} };
  const oldActor = { userId: sourceOwner, accountId: project.account_id, credential: { kind: 'jwt' as const }, ctx: {} };
  expect((await authorize(targetActor, 'project.artifact.read', { type: 'project', id: project.project_id })).allowed).toBe(true);
  expect((await authorize({ ...oldActor, accountId: targetAccount }, 'project.artifact.read', { type: 'project', id: project.project_id })).allowed).toBe(false);
  await expect(createArtifactCommentThread(oldActor, { artifact, viewer: { userId: sourceOwner, privateFolders: new Set(), allPrivateFolders: new Set(), projectWrite: false, manageAny: false, channelFolder: null }, sessionId: null, canEdit: false },
    { body: 'A stale old-tenant write.', anchor: { type: 'none', version: 'api-save' } })).rejects.toMatchObject({ status: 404 });
  const comments = await listArtifactCommentThreads({ artifact: moved!, viewer: { userId: targetOwner, privateFolders: new Set(), allPrivateFolders: new Set(), projectWrite: false, manageAny: false, channelFolder: null }, sessionId: null, canEdit: false }, 'all');
  expect(comments).toHaveLength(4);
  expect(comments[0]!.comments[0]).toMatchObject({ body: 'Retained Artifact feedback.', author: { kind: 'session', session_id: sessionId, agent_name: 'writer', title: 'Transferred writer' } });
  const activity = await readArtifactActivity(moved!, {});
  expect(activity.items.filter((item) => item.type === 'saved')).toHaveLength(2);
  expect(activity.items.every((item) => item.actor.kind === 'session' && item.actor.id === sessionId && item.actor.name === 'writer · Transferred writer')).toBe(true);
  expect(await db.select().from(jobQueue).where(eq(jobQueue.jobId, pendingJob.jobId))).toMatchObject([{ status: 'dead', payload: pendingJob.payload }]);
  expect(await db.select().from(sessionLifecycleCommands).where(eq(sessionLifecycleCommands.commandId, pendingCommand.commandId))).toMatchObject([{ status: 'dead_lettered', result: { status: 'cancelled', reason: 'project_transferred' }, accountId: targetAccount, actorUserId: sourceOwner }]);
  expect(await db.select().from(artifactCommentThreads).where(eq(artifactCommentThreads.threadId, pendingThread.threadId))).toMatchObject([{ agentState: 'paused', agentError: expect.any(String) }]);
  expect(await db.select().from(artifactCommentThreads).where(eq(artifactCommentThreads.threadId, deliveredThread.threadId))).toMatchObject([{ agentState: 'sent', agentError: null }]);
  expect(await db.select().from(artifactCommentThreads).where(eq(artifactCommentThreads.threadId, loopThread.threadId))).toMatchObject([{ agentState: 'paused', agentError: null }]);
  expect(await db.select().from(artifactCommentThreads).where(eq(artifactCommentThreads.threadId, queuedThread.threadId))).toMatchObject([{ agentState: 'paused', agentError: expect.any(String) }]);
  expect(await db.select().from(jobQueue).where(eq(jobQueue.jobId, protectedJob.jobId))).toEqual([protectedJob]);
  expect(await db.select().from(sessionLifecycleCommands).where(eq(sessionLifecycleCommands.commandId, completedCommand.commandId))).toEqual([{ ...completedCommand, accountId: targetAccount }]);
  expect(await db.select().from(sessionLifecycleCommands).where(eq(sessionLifecycleCommands.commandId, unscopedCommand.commandId))).toEqual([{ ...unscopedCommand, accountId: targetAccount }]);
});
