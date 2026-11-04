import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import { artifactComments, artifactCommentThreads, artifacts, drives, jobQueue, projects, projectSessions, sessionLifecycleCommands } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../shared/db';
import { seedProject, removeSeeded, type SeededProject } from '../__tests__/helpers/integration-fixtures';
import { config } from '../config';
import type { Actor } from '../iam/actor';

const surface = await import('../projects/surface');
mock.module('../projects/surface', () => ({ ...surface, resolveAndAuthorizeAgentAs: async () => ({}), loadVisibleSession: async () => null }));
mock.module('../iam/authorize', () => ({ authorize: async () => ({ allowed: true }) }));
mock.module('./comment-delivery', () => ({ rebuildArtifactCommentCreatePrompt: async () => 'Current Artifact feedback.' }));
mock.module('../projects/session-lifecycle/drain', () => ({ drainSessionLifecycleQueue: async () => ({ claimed: 0 }) }));
let creates = 0;
mock.module('../projects/lib/sessions', () => ({ createProjectSession: async (input: {
  project: { projectId: string; accountId: string }; userId: string; body: { session_id: string; agent_name: string };
}) => {
  creates++;
  const [row] = await db.insert(projectSessions).values({ sessionId: input.body.session_id, projectId: input.project.projectId,
    accountId: input.project.accountId, createdBy: input.userId, branchName: `session/${input.body.session_id}`, agentName: input.body.agent_name }).returning();
  return { row };
} }));
const { executeQueuedCreate } = await import('../projects/session-lifecycle/create-session');
const seeded: SeededProject[] = [];
let project: typeof projects.$inferSelect;
let row: typeof sessionLifecycleCommands.$inferSelect;
const reserved = crypto.randomUUID();
const storageKey = config.PLATINUM_API_KEY;

beforeAll(async () => {
  config.PLATINUM_API_KEY = 'synthetic-queued-create';
  const seededProject = await seedProject(`comment-queued-create-${crypto.randomUUID()}`, { metadata: { experimental: { artifacts: true, artifact_comments: true } } });
  seeded.push(seededProject);
  [project] = await db.select().from(projects).where(eq(projects.projectId, seededProject.project_id)) as [typeof projects.$inferSelect];
  const actor: Actor = { accountId: project.accountId, userId: crypto.randomUUID(), credential: { kind: 'jwt' }, ctx: {} };
  const [drive] = await db.insert(drives).values({ accountId: project.accountId, projectId: project.projectId, kind: 'project', name: 'Queued proof', platinumVolumeName: `queued-${crypto.randomUUID()}` }).returning();
  const [artifact] = await db.insert(artifacts).values({ accountId: project.accountId, projectId: project.projectId, driveId: drive!.driveId,
    root: 'queued.md', entry: 'queued.md', folder: false, type: 'doc', title: 'Queued proof', visibility: 'project', createdByUserId: actor.userId }).returning();
  const [thread] = await db.insert(artifactCommentThreads).values({ artifactId: artifact!.artifactId, projectId: project.projectId,
    createdByUserId: actor.userId, anchor: { type: 'none', version: 'v1' }, anchorVersion: 'v1', agentState: 'pending' }).returning();
  const [comment] = await db.insert(artifactComments).values({ threadId: thread!.threadId, authorUserId: actor.userId,
    body: '@builder Review.', mentions: [{ kind: 'agent', agent_name: 'builder' }] }).returning();
  const key = `artifact-comments:batch:${crypto.randomUUID()}`;
  const [job] = await db.insert(jobQueue).values({ queue: 'artifact-comment-agents', jobKey: key, artifactId: artifact!.artifactId,
    payload: { artifactId: artifact!.artifactId, actor, callerSessionId: null, threadIds: [thread!.threadId], commentId: comment!.commentId,
      targets: [{ recipientKey: 'agent:builder', agentName: 'builder', sessionId: reserved, created: true, status: 'pending', implicit: false, key }] } }).returning();
  [row] = await db.insert(sessionLifecycleCommands).values({ commandType: 'create_session', source: 'system:artifact-comment', status: 'queued',
    accountId: project.accountId, projectId: project.projectId, artifactId: artifact!.artifactId, actorUserId: actor.userId, idempotencyKey: key,
    payload: { body: { session_id: reserved, agent_name: 'builder' }, requestingPrincipalType: 'human',
      metadata: { artifactCommentDelivery: { job_id: job!.jobId, target_key: key } } } }).returning() as [typeof sessionLifecycleCommands.$inferSelect];
});
afterAll(async () => { config.PLATINUM_API_KEY = storageKey; await removeSeeded(seeded); });

test('a real persisted queued Artifact create retains its key through authority replay and existing-row deduplication', async () => {
  const { revalidateArtifactCommentCreate } = await import('./comment-authority');
  await revalidateArtifactCommentCreate({ source: 'system:artifact-comment', project, requestingPrincipalType: 'human', userId: row.actorUserId!, artifactId: row.artifactId!,
    body: row.payload.body as { session_id: string; agent_name: string }, metadata: row.payload.metadata as Record<string, unknown>, idempotencyKey: row.idempotencyKey });
  for (const idempotencyKey of [null, `${row.idempotencyKey}:other`]) {
    expect(await executeQueuedCreate({ ...row, idempotencyKey })).toMatchObject({ status: 'failed', error: { status: 403 } });
  }
  expect(creates).toBe(0);
  const result = await executeQueuedCreate(row);
  expect(result).toMatchObject({ status: 'created', sessionId: reserved });
  expect(await db.select().from(projectSessions).where(eq(projectSessions.sessionId, reserved))).toHaveLength(1);
  expect(await executeQueuedCreate({ ...row, sessionId: reserved })).toMatchObject({ status: 'created', sessionId: reserved });
  expect(creates).toBe(1);
});
