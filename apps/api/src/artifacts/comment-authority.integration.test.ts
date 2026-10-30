import { afterAll, afterEach, beforeAll, expect, mock, test } from 'bun:test';
import { accounts, artifactComments, artifactCommentThreads, artifacts, drives, jobQueue, projects } from '@kortix/db';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../shared/db';
import { localTestDatabaseUrl } from '../__tests__/helpers/integration-fixtures';

mock.module('../iam/authorize', () => ({ authorize: async () => ({ allowed: true }) }));
mock.module('../iam/actor', () => ({ actingPrincipal: () => ({ type: 'user' }), loadTokenBinding: { invalidate() {} },
  tokenCredential: async () => { throw new Error('This suite uses a JWT actor'); } }));
mock.module('../notifications/access', () => ({ mayPromptSessions: async () => new Set() }));
mock.module('../feature-flags/registry', () => ({ resolveFeatureFlag: () => true }));
mock.module('../projects/surface', () => ({ resolveAndAuthorizeAgentAs: async () => ({}), loadVisibleSession: async () => null, sessionIsTombstoned: () => false }));
mock.module('../drives/service', () => ({ privateChannelFoldersFor: async () => ({ visible: new Set(), all: new Set() }) }));
mock.module('./service', () => ({ canView: () => true }));

const { ArtifactCommentAuthorityError, revalidateArtifactCommentCreate } = await import('./comment-authority');
const userId = crypto.randomUUID();
const accountId = crypto.randomUUID();
const reserved = crypto.randomUUID();
const jobId = crypto.randomUUID();
const targetKey = `artifact-comments:test:${crypto.randomUUID()}`;
const fixtures: Array<{ project: typeof projects.$inferSelect; artifactId: string; threadId: string; commentId: string }> = [];

const payload = (index = 0) => ({
  actor: { accountId, userId, credential: { kind: 'jwt' }, ctx: {} }, callerSessionId: null,
  artifactId: fixtures[index]!.artifactId, threadIds: [fixtures[index]!.threadId], commentId: fixtures[index]!.commentId,
  targets: [{ recipientKey: 'agent:builder', sessionId: reserved, agentName: 'builder', created: true,
    key: targetKey, implicit: false, status: 'pending' }],
});
const command = (artifactId = fixtures[0]!.artifactId) => ({ source: 'system:artifact-comment' as const, artifactId,
  project: fixtures[0]!.project, userId, requestingPrincipalType: 'human' as const,
  body: { session_id: reserved, agent_name: 'builder' }, idempotencyKey: targetKey,
  metadata: { artifactCommentDelivery: { job_id: jobId, target_key: targetKey } },
});

beforeAll(async () => {
  localTestDatabaseUrl();
  await db.insert(accounts).values({ accountId, name: 'Artifact authority test' });
  for (let i = 0; i < 2; i++) {
    const [project] = await db.insert(projects).values({ accountId, name: `Authority ${i}`, repoUrl: 'https://example.test/authority.git',
      metadata: { experimental: { artifacts: true, artifact_comments: true } } }).returning();
    const [drive] = await db.insert(drives).values({ accountId, projectId: project!.projectId, kind: 'project', name: 'Authority fixture',
      platinumVolumeName: `test-authority-${crypto.randomUUID()}` }).returning();
    const [artifact] = await db.insert(artifacts).values({ accountId, projectId: project!.projectId, driveId: drive!.driveId,
      root: 'authority.md', entry: 'authority.md', folder: false, type: 'doc', title: 'Authority', visibility: 'project', createdByUserId: userId }).returning();
    const [thread] = await db.insert(artifactCommentThreads).values({ artifactId: artifact!.artifactId, projectId: project!.projectId,
      createdByUserId: userId, anchor: { type: 'none', version: 'v1' }, anchorVersion: 'v1' }).returning();
    const [comment] = await db.insert(artifactComments).values({ threadId: thread!.threadId, authorUserId: userId, body: '@builder Review this.',
      mentions: [{ kind: 'agent', agent_name: 'builder' }] }).returning();
    fixtures.push({ project: project!, artifactId: artifact!.artifactId, threadId: thread!.threadId, commentId: comment!.commentId });
  }
  await db.insert(jobQueue).values({ jobId, queue: 'artifact-comment-agents', jobKey: targetKey, artifactId: fixtures[0]!.artifactId, payload: payload() });
});

afterEach(async () => {
  await db.update(jobQueue).set({ queue: 'artifact-comment-agents', artifactId: fixtures[0]!.artifactId, payload: payload() }).where(eq(jobQueue.jobId, jobId));
  await db.update(artifactComments).set({ mentions: [{ kind: 'agent', agent_name: 'builder' }], deletedAt: null }).where(eq(artifactComments.commentId, fixtures[0]!.commentId));
});
afterAll(async () => {
  await db.delete(projects).where(inArray(projects.projectId, fixtures.map((fixture) => fixture.project.projectId)));
  await db.delete(accounts).where(eq(accounts.accountId, accountId));
});

test('the exact persisted job, artifact, thread and reserved target permit delayed creation', async () => {
  const result = await revalidateArtifactCommentCreate(command());
  expect(result).toMatchObject({ actor: { accountId, userId }, callerSessionId: null });
});

test('a job with the same id in another queue cannot provide authority', async () => {
  await db.update(jobQueue).set({ queue: 'another-queue' }).where(eq(jobQueue.jobId, jobId));
  await expect(revalidateArtifactCommentCreate(command())).rejects.toBeInstanceOf(ArtifactCommentAuthorityError);
});

test('a source artifact in another project cannot authorize this project create', async () => {
  await db.update(jobQueue).set({ artifactId: fixtures[1]!.artifactId, payload: payload(1) }).where(eq(jobQueue.jobId, jobId));
  await expect(revalidateArtifactCommentCreate(command(fixtures[1]!.artifactId))).rejects.toBeInstanceOf(ArtifactCommentAuthorityError);
});

test('a thread and comment from another artifact cannot enter this delivery', async () => {
  await db.update(jobQueue).set({ payload: { ...payload(), threadIds: [fixtures[1]!.threadId], commentId: fixtures[1]!.commentId } }).where(eq(jobQueue.jobId, jobId));
  await expect(revalidateArtifactCommentCreate(command())).rejects.toBeInstanceOf(ArtifactCommentAuthorityError);
});

test('removing the persisted mention or deleting the source comment cancels delayed creation', async () => {
  await db.update(artifactComments).set({ mentions: [] }).where(eq(artifactComments.commentId, fixtures[0]!.commentId));
  await expect(revalidateArtifactCommentCreate(command())).rejects.toBeInstanceOf(ArtifactCommentAuthorityError);
  await db.update(artifactComments).set({ mentions: [{ kind: 'agent', agent_name: 'builder' }], deletedAt: new Date() }).where(eq(artifactComments.commentId, fixtures[0]!.commentId));
  await expect(revalidateArtifactCommentCreate(command())).rejects.toBeInstanceOf(ArtifactCommentAuthorityError);
});

test('inherited delivery retains its original mention authority after a later plain reply', async () => {
  const original = fixtures[0]!;
  const [reply] = await db.insert(artifactComments).values({ threadId: original.threadId, authorUserId: userId, body: 'More detail without a mention.', mentions: [] }).returning();
  const inherited = payload();
  inherited.commentId = reply!.commentId;
  inherited.targets = inherited.targets.map((target) => ({ ...target, implicit: true, originCommentId: original.commentId }));
  await db.update(jobQueue).set({ payload: inherited }).where(eq(jobQueue.jobId, jobId));
  await expect(revalidateArtifactCommentCreate(command())).resolves.toMatchObject({ callerSessionId: null });
  await db.update(artifactComments).set({ mentions: [] }).where(eq(artifactComments.commentId, original.commentId));
  await expect(revalidateArtifactCommentCreate(command())).rejects.toBeInstanceOf(ArtifactCommentAuthorityError);
});

test('an origin mention from another Artifact cannot authorize an inherited target', async () => {
  const inherited = payload();
  inherited.targets = inherited.targets.map((target) => ({ ...target, implicit: true, originCommentId: fixtures[1]!.commentId }));
  await db.update(jobQueue).set({ payload: inherited }).where(eq(jobQueue.jobId, jobId));
  await expect(revalidateArtifactCommentCreate(command())).rejects.toBeInstanceOf(ArtifactCommentAuthorityError);
});
