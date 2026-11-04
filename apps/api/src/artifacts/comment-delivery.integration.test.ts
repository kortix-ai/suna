import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { artifactComments, artifactCommentScreenshotObjects, artifactCommentThreads, artifactEvents, artifacts, drives, jobQueue, projectSessions, sessionLifecycleCommands, sessionSandboxes } from '@kortix/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { seedProject, seedSession, removeSeeded, type SeededProject } from '../__tests__/helpers/integration-fixtures';
import { db } from '../shared/db';
import type { Actor } from '../iam/actor';
import { pruneFinishedJobs } from '../shared/job-queue';
import { config } from '../config';
import type { ArtifactCommentLifecycleReceipt } from './comment-lifecycle-wake';

let stats = 0;
let missingEntry = false;
let callerSessionId: string | null = null;
const refused = new Set<string>();
const unavailable = new Set<string>();
const wakes: ArtifactCommentLifecycleReceipt[] = [];
const wakeChecks: Array<Promise<{ visible: boolean; unlocked: boolean }>> = [];
mock.module('./comment-lifecycle-wake', () => ({
  wakeArtifactCommentLifecycle: (receipt: ArtifactCommentLifecycleReceipt) => {
    wakes.push(receipt);
    wakeChecks.push(db.transaction(async (tx) => {
      const [command] = await tx.select().from(sessionLifecycleCommands).where(eq(sessionLifecycleCommands.idempotencyKey, receipt.idempotencyKey));
      if (!command?.artifactId) return { visible: false, unlocked: false };
      await tx.execute(sql`select artifact_id from kortix.artifacts where artifact_id = ${command.artifactId} for update nowait`);
      return { visible: true, unlocked: true };
    }).catch(() => ({ visible: false, unlocked: false })));
  },
}));
class ArtifactCommentAuthorityError extends Error { readonly status = 403; readonly code = 'artifact_comment_agent_forbidden'; }
const vision = await import('../channels/vision-model');
mock.module('../channels/vision-model', () => ({ ...vision, modelReadsImages: (_project: string, model: string | null) => model?.includes('screenshot-vision') === true }));
const volumes = await import('../drives/volumes');
mock.module('../drives/volumes', () => ({ ...volumes, statVolumeFile: async () => { stats++; return { version: missingEntry ? null : 'actual-entry-etag' }; } }));
mock.module('./comment-authority', () => ({
  ArtifactCommentAuthorityError,
  authorizeArtifactCommentAgent: async (actor: Actor, _project: unknown, agentName: string, session?: unknown) => ({ actor, agentName, canPromptExisting: !!session, callerSessionId }),
  assertArtifactCommentDeliveryAccess: async () => {},
  revalidateArtifactCommentContinue: async (row: { artifactId: string; projectId: string }, reference: { job_id: string; target_key: string }) => {
    if (unavailable.has(reference.target_key)) throw new Error('Credential validation is temporarily unavailable');
    const [stored] = await db.select().from(jobQueue).where(eq(jobQueue.jobId, reference.job_id));
    const payload = stored!.payload as import('./comment-delivery').ArtifactCommentAgentPayload;
    const target = payload.targets!.find((entry) => entry.key === reference.target_key)!;
    const { artifactCommentOriginIsCurrent } = await import('./comment-mentions');
    if (refused.has(reference.target_key) || !await artifactCommentOriginIsCurrent(row, payload.threadIds, target)) throw new ArtifactCommentAuthorityError();
    return { actor: payload.actor, callerSessionId: null, payload };
  },
}));
const { dispatchArtifactCommentJobs, enqueueArtifactCommentRouting, rebuildArtifactCommentContinuePrompt, runArtifactCommentAgentJob, sendArtifactCommentThreads } = await import('./comment-delivery');
const { priorArtifactAgentTargets } = await import('./comment-mentions');
type Job = typeof jobQueue.$inferSelect;

describe.skipIf(!process.env.TEST_DATABASE_URL)('Artifact comment delivery journal', () => {
  const seeded: SeededProject[] = [];
  let project: SeededProject;
  let artifact: typeof artifacts.$inferSelect;
  let actor: Actor;
  let sessionId: string;
  const storageKey = config.PLATINUM_API_KEY;

  beforeEach(async () => {
    callerSessionId = null;
    stats = 0;
    missingEntry = false;
    refused.clear(); unavailable.clear();
    await Promise.all(wakeChecks);
    wakes.length = 0; wakeChecks.length = 0;
    config.PLATINUM_API_KEY = 'synthetic-delivery-storage';
    project = await seedProject(`comment-delivery-${crypto.randomUUID()}`, { metadata: { experimental: { artifacts: true, artifact_comments: true } } });
    seeded.push(project);
    actor = { accountId: project.account_id, userId: crypto.randomUUID(), credential: { kind: 'jwt' }, ctx: {} };
    sessionId = await seedSession(project, actor.userId);
    await db.update(projectSessions).set({ agentName: 'writer' }).where(eq(projectSessions.sessionId, sessionId));
    const [drive] = await db.insert(drives).values({ accountId: actor.accountId, projectId: project.project_id, kind: 'project',
      name: 'Synthetic delivery Files', platinumVolumeName: `delivery-${crypto.randomUUID()}`, platinumVolumeId: `synthetic-${crypto.randomUUID()}` }).returning();
    [artifact] = await db.insert(artifacts).values({ accountId: actor.accountId, projectId: project.project_id, driveId: drive!.driveId,
      root: '/report', entry: 'index.md', folder: true, type: 'doc', title: 'Synthetic report', visibility: 'project',
      createdByUserId: actor.userId, createdBySessionId: sessionId }).returning() as [typeof artifacts.$inferSelect];
  });
  afterAll(async () => { config.PLATINUM_API_KEY = storageKey; await Promise.all(wakeChecks); await removeSeeded(seeded); await db.delete(artifactCommentScreenshotObjects).where(inArray(artifactCommentScreenshotObjects.projectId, seeded.map(row => row.project_id))); });

  async function thread(body: string, agent = false) {
    const [row] = await db.insert(artifactCommentThreads).values({ artifactId: artifact.artifactId, projectId: artifact.projectId,
      anchor: { type: 'none', version: 'older-anchor-version' }, anchorVersion: 'older-anchor-version', createdByUserId: actor.userId }).returning();
    const [comment] = await db.insert(artifactComments).values({ threadId: row!.threadId, body, authorUserId: actor.userId,
      mentions: agent ? [{ kind: 'session', session_id: sessionId, agent_name: 'writer' }] : [] }).returning();
    return { row: row!, comment: comment! };
  }
  async function job(source: Awaited<ReturnType<typeof thread>>, reply = false): Promise<Job> {
    const key = await db.transaction((tx) => enqueueArtifactCommentRouting(tx, artifact, actor, null, source.row.threadId, source.comment.commentId, reply));
    const [row] = await db.update(jobQueue).set({ attempts: 1 }).where(and(eq(jobQueue.queue, 'artifact-comment-agents'), eq(jobQueue.jobKey, key))).returning();
    return row!;
  }
  const commands = () => db.select().from(sessionLifecycleCommands).where(eq(sessionLifecycleCommands.artifactId, artifact.artifactId));
  const events = () => db.select().from(artifactEvents).where(and(eq(artifactEvents.artifactId, artifact.artifactId), eq(artifactEvents.type, 'sent_to_agent')));

  async function digest() {
    const token = crypto.randomUUID();
    await db.insert(sessionSandboxes).values({ sandboxId: crypto.randomUUID(), sessionId, projectId: artifact.projectId, accountId: actor.accountId, provider: 'platinum', status: 'active',
      metadata: { activeTurns: { [token]: { token, state: 'active', runtimeSessionId: 'synthetic-runtime', messageId: 'synthetic-message', startedAtMs: Date.now() } } } });
    const first = await thread('First digest concern.', true);
    const second = await thread('Second digest concern.', true);
    const firstJob = await job(first);
    const secondJob = await job(second);
    await runArtifactCommentAgentJob(firstJob);
    await Promise.all(wakeChecks);
    await runArtifactCommentAgentJob(secondJob);
    return { first, second, firstJob, secondJob, command: (await commands())[0]! };
  }

  test('an existing-session handoff wakes only its committed unlocked command', async () => {
    const claimed = await job(await thread('Wake this exact handoff.', true));
    await runArtifactCommentAgentJob(claimed);
    const [command] = await commands();
    expect(wakes).toEqual([{ idempotencyKey: claimed.jobKey, availableAt: command!.availableAt }]);
    expect(await Promise.all(wakeChecks)).toEqual([{ visible: true, unlocked: true }]);
  });

  test('digest append wakes the original command key and its persisted future availability', async () => {
    const started = Date.now();
    const state = await digest();
    expect(state.command.availableAt.getTime()).toBeGreaterThanOrEqual(started + 15_000);
    expect(wakes).toEqual([state.firstJob, state.secondJob].map(() => ({
      idempotencyKey: state.firstJob.jobKey, availableAt: state.command.availableAt,
    })));
    expect(await Promise.all(wakeChecks)).toEqual([{ visible: true, unlocked: true }, { visible: true, unlocked: true }]);
  });

  test('new and inherited pending-session handoffs wake the actual durable create key', async () => {
    const claimed = await job(await thread('Create one reserved agent session.', true));
    const payload = claimed.payload as import('./comment-delivery').ArtifactCommentAgentPayload;
    payload.targets = [{ recipientKey: `session:${sessionId}`, sessionId: crypto.randomUUID(), agentName: 'writer', created: true,
      initialized: true, key: claimed.jobKey, implicit: false, status: 'pending' }];
    await db.update(jobQueue).set({ payload }).where(eq(jobQueue.jobId, claimed.jobId));
    await expect(runArtifactCommentAgentJob({ ...claimed, payload })).rejects.toThrow('still being created');
    const [command] = await commands();
    expect(command!.commandType).toBe('create_session');
    expect(await Promise.all(wakeChecks)).toEqual([{ visible: true, unlocked: true }]);
    const inherited = await job(await thread('Reuse the reserved agent session.', true));
    const inheritedPayload = inherited.payload as import('./comment-delivery').ArtifactCommentAgentPayload;
    inheritedPayload.targets = [{ ...payload.targets[0]!, created: false, key: inherited.jobKey, createKey: claimed.jobKey }];
    await db.update(jobQueue).set({ payload: inheritedPayload }).where(eq(jobQueue.jobId, inherited.jobId));
    await expect(runArtifactCommentAgentJob({ ...inherited, payload: inheritedPayload })).rejects.toThrow('still being created');
    expect(wakes).toEqual([claimed, inherited].map(() => ({ idempotencyKey: claimed.jobKey, availableAt: command!.availableAt })));
    expect(await Promise.all(wakeChecks)).toEqual([{ visible: true, unlocked: true }, { visible: true, unlocked: true }]);
    expect(await commands()).toHaveLength(1);
  });

  test('a commit failure leaves the target pending and never wakes a rolled-back command', async () => {
    const claimed = await job(await thread('Do not wake a rolled-back handoff.', true));
    await db.execute(sql.raw(`create function kortix.synthetic_artifact_wake_rollback() returns trigger language plpgsql as $$
      begin if new.artifact_id = '${artifact.artifactId}'::uuid then raise exception 'synthetic commit failure'; end if; return new; end $$`));
    await db.execute(sql.raw('create constraint trigger synthetic_artifact_wake_rollback after insert on kortix.artifact_events deferrable initially deferred for each row execute function kortix.synthetic_artifact_wake_rollback()'));
    try {
      await expect(runArtifactCommentAgentJob(claimed)).rejects.toThrow();
      expect(wakes).toEqual([]);
      expect(await commands()).toEqual([]);
      expect(await events()).toEqual([]);
      const [stored] = await db.select().from(jobQueue).where(eq(jobQueue.jobId, claimed.jobId));
      expect((stored!.payload as import('./comment-delivery').ArtifactCommentAgentPayload).targets).toMatchObject([{ status: 'pending' }]);
    } finally {
      await db.execute(sql.raw('drop trigger synthetic_artifact_wake_rollback on kortix.artifact_events'));
      await db.execute(sql.raw('drop function kortix.synthetic_artifact_wake_rollback()'));
    }
    await runArtifactCommentAgentJob(claimed);
    expect(wakes).toHaveLength(1);
    expect(await commands()).toHaveLength(1);
  });

  test('a dead-lettered inherited create fails once without retrying or duplicating its target', async () => {
    const source = await thread('Review the existing reservation.', true);
    const claimed = await job(source);
    const createKey = `artifact-comments:batch:${crypto.randomUUID()}`;
    const payload = claimed.payload as import('./comment-delivery').ArtifactCommentAgentPayload;
    payload.targets = [{ recipientKey: `session:${sessionId}`, sessionId, agentName: 'writer', created: false, initialized: true,
      key: claimed.jobKey, createKey, implicit: true, status: 'pending' }];
    await db.update(jobQueue).set({ payload }).where(eq(jobQueue.jobId, claimed.jobId));
    await db.insert(sessionLifecycleCommands).values({ commandType: 'create_session', source: 'system:artifact-comment', status: 'dead_lettered',
      accountId: artifact.accountId, projectId: artifact.projectId, artifactId: artifact.artifactId, actorUserId: actor.userId,
      idempotencyKey: createKey, payload: {} });
    await expect(runArtifactCommentAgentJob({ ...claimed, payload })).rejects.toThrow();
    const [stored] = await db.select().from(jobQueue).where(eq(jobQueue.jobId, claimed.jobId));
    expect((stored!.payload as import('./comment-delivery').ArtifactCommentAgentPayload).targets).toMatchObject([{ status: 'failed', sessionId, createKey }]);
    const [read] = await db.select().from(artifactCommentThreads).where(eq(artifactCommentThreads.threadId, source.row.threadId));
    expect(read).toMatchObject({ agentState: 'paused', agentError: expect.any(String) });
    await expect(runArtifactCommentAgentJob(stored!)).rejects.toThrow();
    expect(await commands()).toHaveLength(1);
    expect(await events()).toHaveLength(0);
  });

  test('plain human feedback writes an id-only people outbox and performs no Files stat', async () => {
    const source = await thread('Check the heading.');
    const key = await db.transaction((tx) => enqueueArtifactCommentRouting(tx, artifact, actor, null, source.row.threadId, source.comment.commentId, false));
    const rows = await db.select().from(jobQueue).where(eq(jobQueue.jobKey, key));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ queue: 'artifact-comment-people', artifactId: artifact.artifactId, payload: { artifactId: artifact.artifactId, commentId: source.comment.commentId } });
    expect(stats).toBe(0);
    expect(await commands()).toEqual([]);
  });

  test('replaying the same delivery retains one command and one event with the real Files version', async () => {
    const source = await thread('Check the total.', true);
    const claimed = await job(source);
    await runArtifactCommentAgentJob(claimed);
    const [stored] = await db.select().from(jobQueue).where(eq(jobQueue.jobId, claimed.jobId));
    await runArtifactCommentAgentJob(stored!);
    const rows = await commands();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ idempotencyKey: claimed.jobKey, sessionId, source: 'system:artifact-comment', artifactId: artifact.artifactId,
      payload: { delivery: 'queue', placement: 'composer' } });
    expect(rows[0]!.payload.text).toContain('actual-entry-etag');
    expect(rows[0]!.payload.text).toContain(`kortix artifacts reply ${source.row.threadId}`);
    expect(await events()).toHaveLength(1);
  });

  test('an expired claimant cannot enqueue a prompt or overwrite target progress', async () => {
    const claimed = await job(await thread('Check this fenced claim.', true));
    await db.update(jobQueue).set({ attempts: 2 }).where(eq(jobQueue.jobId, claimed.jobId));
    await expect(runArtifactCommentAgentJob(claimed)).rejects.toThrow('claim expired');
    expect(await commands()).toEqual([]);
    expect(await events()).toEqual([]);
  });

  test('an edited-away mention clears pending state before target initialization and after a saved target plan', async () => {
    for (const initialized of [false, true]) {
      const source = await thread('Removed agent mention.', true);
      const claimed = await job(source);
      await db.update(artifactComments).set({ mentions: [], body: 'The person removed the mention.' }).where(eq(artifactComments.commentId, source.comment.commentId));
      if (initialized) claimed.payload = { ...claimed.payload, primaryTargetKey: claimed.jobKey, targets: [{
        recipientKey: `session:${sessionId}`, sessionId, agentName: 'writer', created: false, key: claimed.jobKey, implicit: false, status: 'pending',
      }] };
      await runArtifactCommentAgentJob(claimed);
      const [stored] = await db.select().from(artifactCommentThreads).where(eq(artifactCommentThreads.threadId, source.row.threadId));
      expect(stored).toMatchObject({ agentState: 'none', sentSessionId: null, sentAt: null });
    }
    expect(stats).toBe(0);
    expect(await commands()).toEqual([]);
    expect(await events()).toEqual([]);
  });

  test('a later loop pause cancels an older queued job without changing Waiting for a person into a delivery error', async () => {
    const source = await thread('An older pending mention.', true);
    const claimed = await job(source);
    await db.delete(jobQueue).where(and(eq(jobQueue.queue, 'artifact-comment-people'), eq(jobQueue.jobKey, claimed.jobKey)));
    await db.update(artifactCommentThreads).set({ agentState: 'paused', agentError: null }).where(eq(artifactCommentThreads.threadId, source.row.threadId));
    await dispatchArtifactCommentJobs(claimed.jobKey);
    const [stored] = await db.select().from(artifactCommentThreads).where(eq(artifactCommentThreads.threadId, source.row.threadId));
    expect(stored).toMatchObject({ agentState: 'paused', agentError: null });
    expect(await commands()).toEqual([]);
    expect(stats).toBe(0);
  });

  test('a running turn coalesces feedback into one boundary digest and retains every authorization reference', async () => {
    const token = crypto.randomUUID();
    await db.insert(sessionSandboxes).values({ sandboxId: crypto.randomUUID(), sessionId, projectId: artifact.projectId, accountId: actor.accountId, provider: 'platinum', status: 'active',
      metadata: { activeTurns: { [token]: { token, state: 'active', runtimeSessionId: 'synthetic-runtime', messageId: 'synthetic-message', startedAtMs: Date.now() } } } });
    const first = await job(await thread('First concern.', true));
    const second = await job(await thread('Second concern.', true));
    await runArtifactCommentAgentJob(first);
    await runArtifactCommentAgentJob(second);
    const rows = await commands();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ delivery: 'queue', placement: 'composer', artifactCommentDigest: { deliveries: [
      { job_id: first.jobId, target_key: first.jobKey }, { job_id: second.jobId, target_key: second.jobKey },
    ] } });
    expect(rows[0]!.payload.text).toContain('First concern.');
    expect(rows[0]!.payload.text).toContain('Second concern.');
    expect(await events()).toHaveLength(2);
  });

  for (const agentFirst of [true, false]) test(`a digest keeps person and agent identity separate (${agentFirst ? 'agent first' : 'person first'})`, async () => {
    const token = crypto.randomUUID();
    await db.insert(sessionSandboxes).values({ sandboxId: crypto.randomUUID(), sessionId, projectId: artifact.projectId, accountId: actor.accountId, provider: 'platinum', status: 'active',
      metadata: { activeTurns: { [token]: { token, state: 'active', runtimeSessionId: 'synthetic-runtime', messageId: 'synthetic-message', startedAtMs: Date.now() } } } });
    const authorSession = await seedSession(project, actor.userId);
    for (const agent of [agentFirst, !agentFirst]) {
      callerSessionId = agent ? authorSession : null;
      const source = await thread(agent ? 'Agent feedback.' : 'Person feedback.', true);
      const claimed = await job(source);
      const payload: import('./comment-delivery').ArtifactCommentAgentPayload = { ...claimed.payload as import('./comment-delivery').ArtifactCommentAgentPayload, callerSessionId };
      await db.update(jobQueue).set({ payload }).where(eq(jobQueue.jobId, claimed.jobId));
      await runArtifactCommentAgentJob({ ...claimed, payload });
    }
    const rows = await commands();
    expect(rows).toHaveLength(2);
    const person = rows.find((row) => row.payload.bindTurnIdentity === true);
    const agent = rows.find((row) => row.payload.authorSessionId === authorSession);
    expect(person).toBeDefined();
    expect(agent).toBeDefined();
    expect(person?.payload.text).toContain('Person feedback.');
    expect(person?.payload.text).not.toContain('Agent feedback.');
    expect(agent?.payload.text).toContain('Agent feedback.');
    expect(agent?.payload.text).not.toContain('Person feedback.');
    expect(agent?.payload.bindTurnIdentity).not.toBe(true);
  });

  test('a digest drops a removed mention and still delivers the valid reference with cancellation state', async () => {
    const state = await digest();
    await db.update(artifactComments).set({ mentions: [], body: 'Removed digest route.' }).where(eq(artifactComments.commentId, state.first.comment.commentId));
    const text = await rebuildArtifactCommentContinuePrompt(state.command);
    expect(text).toContain(state.second.row.threadId);
    expect(text).not.toContain(state.first.row.threadId);
    expect(text).not.toContain('Removed digest route.');
    const [cancelled] = await db.select().from(artifactCommentThreads).where(eq(artifactCommentThreads.threadId, state.first.row.threadId));
    expect(cancelled).toMatchObject({ agentState: 'none', agentError: null, sentSessionId: null });
  });

  test('a digest preserves valid delivery when another credential is permanently refused and records the failure', async () => {
    const state = await digest();
    refused.add(state.firstJob.jobKey);
    const text = await rebuildArtifactCommentContinuePrompt(state.command);
    expect(text).toContain(state.second.row.threadId);
    expect(text).not.toContain(state.first.row.threadId);
    const [failed] = await db.select().from(artifactCommentThreads).where(eq(artifactCommentThreads.threadId, state.first.row.threadId));
    expect(failed!.agentState).toBe('paused');
    expect(failed!.agentError).toContain('could not be sent');
  });

  test('transient digest credential failures retry the whole command without dropping or failing a reference', async () => {
    const state = await digest();
    unavailable.add(state.firstJob.jobKey);
    await expect(rebuildArtifactCommentContinuePrompt(state.command)).rejects.toThrow('temporarily unavailable');
    const rows = await db.select().from(artifactCommentThreads).where(eq(artifactCommentThreads.artifactId, artifact.artifactId));
    expect(rows.every((row) => row.agentState === 'sent' && row.agentError === null)).toBe(true);
    unavailable.clear();
    const text = await rebuildArtifactCommentContinuePrompt(state.command);
    expect(text).toContain(state.first.row.threadId);
    expect(text).toContain(state.second.row.threadId);
  });

  test('deleting a root clears delivery state even when a second manual handoff exists', async () => {
    const source = await thread('A root with two explicit handoffs.');
    for (let index = 0; index < 2; index++) await sendArtifactCommentThreads(artifact, actor, null, { thread_ids: [source.row.threadId], batch_id: crypto.randomUUID() });
    const rows = await commands();
    expect(rows).toHaveLength(2);
    await db.update(artifactComments).set({ body: '', deletedAt: new Date() }).where(eq(artifactComments.commentId, source.comment.commentId));
    refused.add(rows[0]!.idempotencyKey!);
    await expect(rebuildArtifactCommentContinuePrompt(rows[0]!)).rejects.toBeInstanceOf(ArtifactCommentAuthorityError);
    const [stored] = await db.select().from(artifactCommentThreads).where(eq(artifactCommentThreads.threadId, source.row.threadId));
    expect(stored).toMatchObject({ agentState: 'none', agentError: null, sentSessionId: null, sentAt: null });
  });

  test('a missing Files entry records a visible delivery failure for the queued thread', async () => {
    await runArtifactCommentAgentJob(await job(await thread('Queued before the file disappeared.', true)));
    missingEntry = true;
    await expect(rebuildArtifactCommentContinuePrompt((await commands())[0]!)).rejects.toThrow('entry no longer exists');
    const [stored] = await db.select().from(artifactCommentThreads).where(eq(artifactCommentThreads.artifactId, artifact.artifactId));
    expect(stored!.agentState).toBe('paused');
    expect(stored!.agentError).toContain('could not be sent');
  });

  test('a batch retry returns the original target and keeps its sent state', async () => {
    const source = await thread('One manual batch.');
    const input = { thread_ids: [source.row.threadId], batch_id: crypto.randomUUID() };
    expect(await sendArtifactCommentThreads(artifact, actor, null, input)).toEqual({ session_id: sessionId, created: false });
    expect(await sendArtifactCommentThreads(artifact, actor, null, input)).toEqual({ session_id: sessionId, created: false });
    expect(await commands()).toHaveLength(1);
    const [stored] = await db.select().from(artifactCommentThreads).where(eq(artifactCommentThreads.threadId, source.row.threadId));
    expect(stored!.agentState).toBe('sent');
    expect(await events()).toHaveLength(1);
  });

  test('implicit replies use the latest successful session for each logical recipient', async () => {
    const source = await thread('Original agent thread.');
    await db.update(artifactCommentThreads).set({ createdByUserId: null, createdBySessionId: sessionId, sentSessionId: sessionId }).where(eq(artifactCommentThreads.threadId, source.row.threadId));
    const replacement = await seedSession(project, actor.userId);
    for (const [id, offset] of [[sessionId, 1000], [replacement, 0]] as const) await db.insert(artifactEvents).values({ artifactId: artifact.artifactId, projectId: artifact.projectId,
      type: 'sent_to_agent', createdAt: new Date(Date.now() - offset), data: { thread_id: source.row.threadId, session_id: id, agent_name: 'writer', recipient_key: `session:${sessionId}` } });
    const recipients = await priorArtifactAgentTargets(artifact, [source.row.threadId]);
    expect(recipients).toEqual([{ recipientKey: `session:${sessionId}`, sessionId: replacement, agentName: 'writer' }]);
  });

  test('a reply cannot resurrect an edited-away explicit target from an older pending job', async () => {
    const source = await thread('Original explicit mention.', true);
    const claimed = await job(source);
    await db.update(jobQueue).set({ payload: { ...claimed.payload, primaryTargetKey: claimed.jobKey, targets: [{
      recipientKey: `session:${sessionId}`, sessionId, agentName: 'writer', created: false, key: claimed.jobKey, implicit: false, status: 'pending',
    }] } }).where(eq(jobQueue.jobId, claimed.jobId));
    await db.update(artifactCommentThreads).set({ sentSessionId: sessionId, sentAt: null }).where(eq(artifactCommentThreads.threadId, source.row.threadId));
    await db.update(artifactComments).set({ mentions: [], body: 'The person removed the mention.' }).where(eq(artifactComments.commentId, source.comment.commentId));
    const [reply] = await db.insert(artifactComments).values({ threadId: source.row.threadId, authorUserId: actor.userId, body: 'A later human-only reply.' }).returning();
    const key = await db.transaction((tx) => enqueueArtifactCommentRouting(tx, artifact, actor, null, source.row.threadId, reply!.commentId, true));
    expect(await db.select().from(jobQueue).where(and(eq(jobQueue.queue, 'artifact-comment-agents'), eq(jobQueue.jobKey, key)))).toEqual([]);
    expect(stats).toBe(0);
  });

  test('a queued sent event does not preserve an automatic recipient after its original mention is removed', async () => {
    const source = await thread('Automatic route origin.', true);
    await runArtifactCommentAgentJob(await job(source));
    expect(await events()).toHaveLength(1);
    await db.update(artifactComments).set({ mentions: [], body: 'The route was removed.' }).where(eq(artifactComments.commentId, source.comment.commentId));
    const [reply] = await db.insert(artifactComments).values({ threadId: source.row.threadId, authorUserId: actor.userId, body: 'A later human-only reply.' }).returning();
    const key = await db.transaction((tx) => enqueueArtifactCommentRouting(tx, artifact, actor, null, source.row.threadId, reply!.commentId, true));
    expect(await db.select().from(jobQueue).where(and(eq(jobQueue.queue, 'artifact-comment-agents'), eq(jobQueue.jobKey, key)))).toEqual([]);
  });

  test('an inherited pending route revalidates its original mention before it is delivered', async () => {
    const source = await thread('A pending explicit source.', true);
    const original = await job(source);
    await db.update(jobQueue).set({ payload: { ...original.payload, targets: [{ recipientKey: `session:${sessionId}`, sessionId,
      agentName: 'writer', created: false, key: original.jobKey, implicit: false, originCommentId: source.comment.commentId, status: 'pending' }] } })
      .where(eq(jobQueue.jobId, original.jobId));
    const [reply] = await db.insert(artifactComments).values({ threadId: source.row.threadId, authorUserId: actor.userId, body: 'Reply before removal.' }).returning();
    const key = await db.transaction((tx) => enqueueArtifactCommentRouting(tx, artifact, actor, null, source.row.threadId, reply!.commentId, true));
    const [inherited] = await db.update(jobQueue).set({ attempts: 1 }).where(and(eq(jobQueue.queue, 'artifact-comment-agents'), eq(jobQueue.jobKey, key))).returning();
    expect(inherited).toBeDefined();
    await db.update(artifactComments).set({ mentions: [], body: 'Removed before the queued reply runs.' }).where(eq(artifactComments.commentId, source.comment.commentId));
    await runArtifactCommentAgentJob(inherited!);
    expect(await commands()).toEqual([]);
  });

  test('finished delivery context survives pruning while a prompt is queued and expires after it completes', async () => {
    const claimed = await job(await thread('Retained queued prompt.', true));
    await runArtifactCommentAgentJob(claimed);
    await db.update(jobQueue).set({ status: 'done', updatedAt: sql`now() - interval '8 days'` }).where(eq(jobQueue.jobId, claimed.jobId));
    await pruneFinishedJobs();
    expect(await db.select().from(jobQueue).where(eq(jobQueue.jobId, claimed.jobId))).toHaveLength(1);
    await db.update(sessionLifecycleCommands).set({ status: 'succeeded' }).where(eq(sessionLifecycleCommands.artifactId, artifact.artifactId));
    await pruneFinishedJobs();
    expect(await db.select().from(jobQueue).where(eq(jobQueue.jobId, claimed.jobId))).toHaveLength(0);
  });
  async function screenshot(source: Awaited<ReturnType<typeof thread>>, id = source.comment.commentId) {
    const key = `${artifact.projectId}/artifact-comments/${id}.png`;
    await db.update(artifactComments).set({ screenshotKey: key }).where(eq(artifactComments.commentId, id));
    await db.insert(artifactCommentScreenshotObjects).values({ objectKey: key, projectId: artifact.projectId, commentId: id, state: 'attached', uploadConfirmed: true, sizeBytes: 100 });
    return key;
  }

  test('vision queues byte-free file references and final delivery materializes fresh image parts; text-only sends URLs', async () => {
    await db.update(projectSessions).set({ metadata: { opencode_model: 'kortix/screenshot-vision' } }).where(eq(projectSessions.sessionId, sessionId));
    const source = await thread('Review the marked screenshot.', true);
    await screenshot(source);
    await runArtifactCommentAgentJob(await job(source));
    const command = (await commands())[0]!;
    expect(command.payload.parts).toMatchObject([{ type: 'text', text: expect.stringContaining('Review the marked screenshot.') }, { type: 'file', mime: 'image/png' }]);
    expect(JSON.stringify(command.payload.parts)).not.toContain('base64');
    expect(JSON.stringify(command.payload.parts)).not.toContain('token=');
    const { rebuildArtifactCommentScreenshotMessage } = await import('./comment-screenshot-delivery');
    let reads = 0;
    const store = { read: async () => { reads++; return { bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' as const }; }, put: async () => {}, remove: async () => {} };
    const image = await rebuildArtifactCommentScreenshotMessage(command, undefined, store);
    expect(image.parts).toMatchObject([{ type: 'text', text: image.text }, { type: 'file', mime: 'image/png', url: 'data:image/png;base64,AQID' }]);
    expect(image.text).toContain('/screenshot');
    expect(reads).toBe(1);
    await db.update(projectSessions).set({ metadata: { opencode_model: 'kortix/screenshot-text' } }).where(eq(projectSessions.sessionId, sessionId));
    const text = await rebuildArtifactCommentScreenshotMessage(command, undefined, store);
    expect(text.parts).toBeUndefined();
    expect(text.text).toContain('/screenshot');
    expect(text.text).toContain('does not declare image input');
    expect(reads).toBe(1);
  });

  test('a screenshot deleted while its private read is pending never survives the final source recheck', async () => {
    await db.update(projectSessions).set({ metadata: { opencode_model: 'kortix/screenshot-vision' } }).where(eq(projectSessions.sessionId, sessionId));
    const source = await thread('Live root.', true);
    const [reply] = await db.insert(artifactComments).values({ threadId: source.row.threadId, authorUserId: actor.userId, body: 'Delete this image before dispatch.' }).returning();
    await screenshot(source, reply!.commentId);
    await runArtifactCommentAgentJob(await job(source));
    const command = (await commands())[0]!;
    let open!: () => void, began!: () => void;
    const held = new Promise<void>(resolve => { open = resolve; });
    const started = new Promise<void>(resolve => { began = resolve; });
    const store = { read: async () => { began(); await held; return { bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' as const }; }, put: async () => {}, remove: async () => {} };
    const { rebuildArtifactCommentScreenshotMessage } = await import('./comment-screenshot-delivery');
    const pending = rebuildArtifactCommentScreenshotMessage(command, undefined, store);
    try {
      await started;
      await db.update(artifactComments).set({ body: '', screenshotKey: null, deletedAt: new Date() }).where(eq(artifactComments.commentId, reply!.commentId));
    } finally { open(); }
    const fresh = await pending;
    expect(fresh.parts).toBeUndefined();
    expect(fresh.text).not.toContain('Delete this image');
    expect(fresh.text).not.toContain('/screenshot');
  });

  test('oversized vision Send fails with numeric limits before any command or sent event, while text-only can retry', async () => {
    await db.update(projectSessions).set({ metadata: { opencode_model: 'kortix/screenshot-vision' } }).where(eq(projectSessions.sessionId, sessionId));
    const source = await thread('Many image comments.');
    for (let index = 0; index < 21; index++) {
      const [comment] = await db.insert(artifactComments).values({ threadId: source.row.threadId, authorUserId: actor.userId, body: `Image ${index}` }).returning();
      await screenshot(source, comment!.commentId);
    }
    await expect(sendArtifactCommentThreads(artifact, actor, null, { thread_ids: [source.row.threadId], batch_id: crypto.randomUUID(), agent: 'writer' })).rejects.toMatchObject({ status: 413, code: 'artifact_comment_screenshot_limit', limits: { max_files: 20, max_parts_bytes: 12582912 } });
    expect(await commands()).toEqual([]);
    expect(await events()).toEqual([]);
    await db.update(projectSessions).set({ metadata: { opencode_model: 'kortix/screenshot-text' } }).where(eq(projectSessions.sessionId, sessionId));
    await sendArtifactCommentThreads(artifact, actor, null, { thread_ids: [source.row.threadId], batch_id: crypto.randomUUID(), agent: 'writer' });
    expect(await commands()).toHaveLength(1);
    expect((await commands())[0]!.payload.parts).toBeUndefined();
    expect((await commands())[0]!.payload.text).toContain('/screenshot');
  });

  test('a batch near the image limit rejects combined comment text before job creation or sent state', async () => {
    await db.update(projectSessions).set({ metadata: { opencode_model: 'kortix/screenshot-vision' } }).where(eq(projectSessions.sessionId, sessionId));
    const source = await thread('Four large screenshots and long valid comments.');
    const keys: string[] = [];
    for (let index = 0; index < 4; index++) {
      const [comment] = await db.insert(artifactComments).values({ threadId: source.row.threadId, authorUserId: actor.userId, body: `Screenshot ${index}` }).returning();
      keys.push(await screenshot(source, comment!.commentId));
    }
    await db.update(artifactCommentScreenshotObjects).set({ sizeBytes: 2097152 }).where(inArray(artifactCommentScreenshotObjects.objectKey, keys));
    await db.insert(artifactComments).values(Array.from({ length: 60 }, () => ({ threadId: source.row.threadId, authorUserId: actor.userId, body: '界'.repeat(10000) })));
    await expect(sendArtifactCommentThreads(artifact, actor, null, { thread_ids: [source.row.threadId], batch_id: crypto.randomUUID(), agent: 'writer' }))
      .rejects.toMatchObject({ status: 413, code: 'artifact_comment_screenshot_limit', limits: { max_parts_bytes: 12582912 } });
    expect(await commands()).toEqual([]);
    expect(await events()).toEqual([]);
    expect(await db.select().from(jobQueue).where(eq(jobQueue.artifactId, artifact.artifactId))).toEqual([]);
    expect((await db.select().from(artifactCommentThreads).where(eq(artifactCommentThreads.threadId, source.row.threadId)))[0]!.agentState).toBe('none');
  });

});
