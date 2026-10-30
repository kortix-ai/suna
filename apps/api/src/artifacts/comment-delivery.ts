import { artifactComments, artifactCommentThreads, artifacts, jobQueue, projects, projectSessions, sessionLifecycleCommands, type ArtifactCommentMention } from '@kortix/db';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Actor } from '../iam/actor';
import { resolveFeatureFlag } from '../feature-flags/registry';
import { db } from '../shared/db';
import { completeJob, enqueueJobs, failJob, registerJobHandler, type Job } from '../shared/job-queue';
import { artifactCommentOriginIsCurrent, priorArtifactAgentTargets, type ArtifactAgentRecipient } from './comment-mentions';
import { artifactAgentChainPaused, artifactCommentPrompt } from './comment-prompt';
import { sharedPath, entryVersion, type ArtifactRow } from './service';
import { recordArtifactEvent } from './events-store';
import { isUuid } from '../shared/validate';
import type { ArtifactCommentAnchor } from '@kortix/shared/artifact-comments';
import { config } from '../config';
import { screenshotReferences, screenshotQueuedParts, screenshotTargetCapability, assertScreenshotReferences, SCREENSHOT_LIMIT_MESSAGE } from './comment-screenshot-parts';
import { ArtifactCommentScreenshotError } from './comment-screenshot-validation';
import { wakeArtifactCommentLifecycle } from './comment-lifecycle-wake';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const PEOPLE = 'artifact-comment-people';
const AGENTS = 'artifact-comment-agents';
const MAX_ATTEMPTS = 8;
const FAILURE = 'The comment could not be sent to the agent. Check access and send it again.';

export interface ArtifactCommentTarget {
  recipientKey: string;
  sessionId: string;
  agentName: string;
  created: boolean;
  key: string;
  implicit: boolean;
  status: 'pending' | 'sent' | 'skipped' | 'failed';
  createKey?: string;
  originCommentId?: string;
  initialized?: boolean;
  error?: string;
  errorCode?: string;
}
export interface ArtifactCommentAgentPayload extends Record<string, unknown> {
  artifactId: string;
  threadIds: string[];
  commentId?: string;
  actor: Actor;
  callerSessionId: string | null;
  recipients: Array<ArtifactAgentRecipient & { implicit: boolean }>;
  targets?: ArtifactCommentTarget[];
  primaryTargetKey?: string;
  manual?: boolean;
}

export class ArtifactCommentDeliveryError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, message: string, readonly code: string) { super(message); }
}
const invalid = (message: string) => new ArtifactCommentDeliveryError(409, message, 'artifact_comment_delivery_conflict');

const mentionRecipients = (mentions: ArtifactCommentMention[]) => mentions.flatMap((mention) => mention.kind === 'user' ? [] : [{
  recipientKey: mention.kind === 'session' ? `session:${mention.session_id}` : `agent:${mention.agent_name}`,
  ...(mention.kind === 'session' ? { sessionId: mention.session_id } : {}), agentName: mention.agent_name, implicit: false,
}]);

export async function enqueueArtifactCommentRouting(
  tx: Tx, artifact: ArtifactRow, actor: Actor, callerSessionId: string | null,
  threadId: string, commentId: string, isReply: boolean,
): Promise<string> {
  const key = `artifact-comments:${threadId}:${commentId}`;
  await enqueueJobs(PEOPLE, [{ key, payload: { artifactId: artifact.artifactId, commentId } }], { executor: tx, maxAttempts: MAX_ATTEMPTS, artifactId: artifact.artifactId });
  const [comment] = await tx.select().from(artifactComments).where(eq(artifactComments.commentId, commentId));
  const previous = callerSessionId ? await tx.select({ session: artifactComments.authorSessionId }).from(artifactComments)
    .where(and(eq(artifactComments.threadId, threadId), ne(artifactComments.commentId, commentId)))
    .orderBy(desc(artifactComments.createdAt), desc(artifactComments.commentId)).limit(5) : [];
  const paused = !!callerSessionId && artifactAgentChainPaused(previous.map((row) => row.session ? 'session' : 'user'));
  const recipients = isReply ? (await priorArtifactAgentTargets(artifact, [threadId], tx)).map((target) => ({ ...target, implicit: true })) : [];
  const intended = [...recipients, ...mentionRecipients(comment!.mentions)].filter((target) => target.sessionId !== callerSessionId);
  await tx.update(artifactCommentThreads).set({
    ...(paused ? { agentState: 'paused' as const, agentError: null } : !callerSessionId || intended.length ? { agentState: intended.length ? 'pending' as const : 'none' as const, agentError: null } : {}),
    updatedAt: sql`clock_timestamp()`,
  }).where(eq(artifactCommentThreads.threadId, threadId));
  if (!paused && intended.length) {
    const payload: ArtifactCommentAgentPayload = { artifactId: artifact.artifactId, threadIds: [threadId], commentId, actor, callerSessionId, recipients };
    await enqueueJobs(AGENTS, [{ key, payload }], { executor: tx, maxAttempts: MAX_ATTEMPTS, artifactId: artifact.artifactId });
  }
  return key;
}

async function source(payload: ArtifactCommentAgentPayload, executor: Pick<typeof db, 'select'> = db, allowFailedPause = false) {
  const [row] = await executor.select({ artifact: artifacts, project: projects }).from(artifacts)
    .innerJoin(projects, and(eq(projects.projectId, artifacts.projectId), eq(projects.accountId, artifacts.accountId)))
    .where(eq(artifacts.artifactId, payload.artifactId));
  if (!row || row.artifact.accountId !== payload.actor.accountId || !resolveFeatureFlag(row.project.metadata, 'artifact_comments')) throw invalid('The Artifact is no longer available');
  const threads = await executor.select().from(artifactCommentThreads).where(and(eq(artifactCommentThreads.artifactId, row.artifact.artifactId),
    eq(artifactCommentThreads.projectId, row.artifact.projectId), inArray(artifactCommentThreads.threadId, payload.threadIds)));
  if (threads.length !== payload.threadIds.length) throw new ArtifactCommentDeliveryError(404, 'Comment thread not found', 'not_found');
  if (threads.some((thread) => thread.agentState === 'paused' && !(allowFailedPause && thread.agentError !== null)) && !(payload.manual && !payload.callerSessionId)) {
    throw new ArtifactCommentDeliveryError(409, 'The comment thread is waiting for a person', 'artifact_comment_paused');
  }
  const comments = await executor.select().from(artifactComments).where(inArray(artifactComments.threadId, payload.threadIds))
    .orderBy(asc(artifactComments.createdAt), asc(artifactComments.commentId));
  if (threads.some((thread) => { const root = comments.find((comment) => comment.threadId === thread.threadId); return !root || root.deletedAt; })) throw invalid('A comment thread was deleted');
  const comment = payload.commentId ? comments.find((entry) => entry.commentId === payload.commentId) : null;
  if (payload.commentId && (!comment || comment.deletedAt)) throw invalid('The comment was deleted');
  return { ...row, threads, comments, comment };
}

const ownClaim = (job: Job) => and(eq(jobQueue.jobId, job.jobId), eq(jobQueue.attempts, job.attempts), eq(jobQueue.status, 'queued'));

async function initializeTargets(job: Job, payload: ArtifactCommentAgentPayload, loaded: Awaited<ReturnType<typeof source>>) {
  if (payload.targets) return;
  const recipients: Array<ArtifactAgentRecipient & { implicit: boolean }> = [...payload.recipients,
    ...mentionRecipients(loaded.comment?.mentions ?? []).map((recipient) => ({ ...recipient, originCommentId: payload.commentId }))];
  const unique = new Map<string, typeof recipients[number]>();
  for (const recipient of recipients) {
    if (recipient.sessionId === payload.callerSessionId || unique.has(recipient.recipientKey)
      || !(await artifactCommentOriginIsCurrent(loaded.artifact, payload.threadIds, recipient))) continue;
    unique.set(recipient.recipientKey, recipient);
  }
  const targets: ArtifactCommentTarget[] = [];
  for (const recipient of unique.values()) {
    targets.push({ recipientKey: recipient.recipientKey, sessionId: recipient.sessionId ?? randomUUID(), agentName: recipient.agentName,
      created: !recipient.sessionId, initialized: false,
      key: targets.length ? `${job.jobKey}:target:${recipient.recipientKey}` : job.jobKey, implicit: recipient.implicit,
      status: 'pending', ...(recipient.createKey ? { createKey: recipient.createKey } : {}),
      ...(recipient.originCommentId ? { originCommentId: recipient.originCommentId } : {}) });
  }
  await db.transaction(async (tx) => {
    const [artifact] = await tx.select({ id: artifacts.artifactId }).from(artifacts).where(eq(artifacts.artifactId, payload.artifactId)).for('update');
    if (!artifact) throw invalid('The Artifact is no longer available');
    payload.targets = targets;
    payload.primaryTargetKey = targets[0]?.key;
    await saveProgress(tx, job, payload);
    await updateThreadDeliveryState(tx, payload);
  });
}

async function initializeTarget(job: Job, payload: ArtifactCommentAgentPayload, target: ArtifactCommentTarget,
  loaded: Awaited<ReturnType<typeof source>>, session: typeof projectSessions.$inferSelect | undefined, canPromptExisting: boolean) {
  if (!target.created && session && canPromptExisting) target.createKey = undefined;
  else if (!target.created && !target.createKey) {
    target.created = true;
    target.sessionId = randomUUID();
  }
  await db.transaction(async (tx) => {
    const [artifact] = await tx.select({ id: artifacts.artifactId }).from(artifacts).where(eq(artifacts.artifactId, payload.artifactId)).for('update');
    if (!artifact) throw invalid('The Artifact is no longer available');
    if (target.created || (target.createKey && !session)) {
      const pending = await tx.select({ payload: jobQueue.payload }).from(jobQueue).where(and(eq(jobQueue.queue, AGENTS), eq(jobQueue.artifactId, payload.artifactId),
        eq(jobQueue.status, 'queued'), ne(jobQueue.jobId, job.jobId))).orderBy(desc(jobQueue.createdAt));
      let waiting = false;
      for (const row of pending) {
        const prior = row.payload as ArtifactCommentAgentPayload;
        if (prior.actor.userId !== payload.actor.userId || JSON.stringify(prior.actor.credential) !== JSON.stringify(payload.actor.credential)) continue;
        const reserved = prior.targets?.find((entry) => entry.recipientKey === target.recipientKey && entry.created && entry.status === 'pending' && entry.initialized
          && (!target.createKey || entry.key === target.createKey));
        if (!reserved || !(await artifactCommentOriginIsCurrent(loaded.artifact, prior.threadIds, reserved, tx))) continue;
        try { await source(prior, tx); }
        catch (error) {
          if (error instanceof ArtifactCommentDeliveryError) continue;
          throw error;
        }
        const [command] = await tx.select({ status: sessionLifecycleCommands.status }).from(sessionLifecycleCommands).where(and(
          eq(sessionLifecycleCommands.artifactId, payload.artifactId), eq(sessionLifecycleCommands.idempotencyKey, reserved.key)));
        if (command && !['queued', 'running', 'succeeded'].includes(command.status)) continue;
        target.created = false; target.sessionId = reserved.sessionId; target.createKey = reserved.key;
        waiting = true;
        break;
      }
      if (!waiting && !target.created) {
        target.created = true;
        target.createKey = undefined;
        target.sessionId = randomUUID();
      }
    }
    target.initialized = true;
    await saveProgress(tx, job, payload);
    await updateThreadDeliveryState(tx, payload);
  });
}

async function saveProgress(tx: Tx, job: Job, payload: ArtifactCommentAgentPayload) {
  const saved = await tx.update(jobQueue).set({ payload, updatedAt: new Date() }).where(ownClaim(job)).returning({ id: jobQueue.jobId });
  if (!saved.length) throw invalid('The comment delivery claim expired');
}

async function updateThreadDeliveryState(tx: Tx, payload: ArtifactCommentAgentPayload) {
  const targets = payload.targets ?? [];
  const display = targets.find((target) => target.status === 'sent' || target.status === 'pending');
  const pending = targets.some((target) => target.status === 'pending');
  const sent = targets.some((target) => target.status === 'sent');
  const failed = targets.some((target) => target.status === 'failed');
  await tx.update(artifactCommentThreads).set({ agentState: pending ? 'pending' : failed ? 'paused' : sent ? 'sent' : 'none', agentError: !pending && failed ? targets.find(target => target.status === 'failed')?.error ?? FAILURE : null,
    sentSessionId: display?.sessionId ?? null, ...(display?.status === 'sent' ? { sentAt: new Date() } : !display ? { sentAt: null } : {}) })
    .where(and(eq(artifactCommentThreads.artifactId, payload.artifactId), inArray(artifactCommentThreads.threadId, payload.threadIds), ne(artifactCommentThreads.agentState, 'paused')));
}

async function deliverToExisting(job: Job, payload: ArtifactCommentAgentPayload, target: ArtifactCommentTarget,
  loaded: Awaited<ReturnType<typeof source>>, actor: Actor, text: string, version: string) {
  const capability = loaded.comments.some(comment => !comment.deletedAt && comment.screenshotKey)
    ? await screenshotTargetCapability(loaded.artifact.projectId, target.sessionId) : { known: true, vision: false, mayNeedImages: false };
  const imageParts = await screenshotQueuedParts(loaded.artifact, loaded.comments, target.sessionId, text);
  const { buildContinueSessionCommandValues, sessionHoldsLiveTurn } = await import('../projects/surface');
  const running = await sessionHoldsLiveTurn(target.sessionId);
  const receipt = await db.transaction(async (tx) => {
    const [artifact] = await tx.select({ id: artifacts.artifactId }).from(artifacts).where(eq(artifacts.artifactId, payload.artifactId)).for('update');
    if (!artifact) throw invalid('The Artifact is no longer available');
    let digestThreads = payload.threadIds;
    const [pending] = running ? await tx.select().from(sessionLifecycleCommands).where(and(eq(sessionLifecycleCommands.sessionId, target.sessionId),
      eq(sessionLifecycleCommands.status, 'queued'), eq(sessionLifecycleCommands.actorUserId, actor.userId),
      sql`${sessionLifecycleCommands.payload}->'artifactCommentDigest'->>'artifactId' = ${payload.artifactId}`,
      sql`coalesce((${sessionLifecycleCommands.payload}->>'bindTurnIdentity')::boolean, false) = ${!payload.callerSessionId}`,
      sql`${sessionLifecycleCommands.payload}->>'authorSessionId' is not distinct from ${payload.callerSessionId}`)).limit(1).for('update') : [];
    if (pending) {
      const state = pending.payload.artifactCommentDigest as { threadIds: string[]; keys: string[]; deliveries: Array<{ job_id: string; target_key: string }> };
      if (!state.keys.includes(target.key)) {
        digestThreads = [...new Set([...state.threadIds, ...payload.threadIds])];
        const digestSource = await source({ ...payload, threadIds: digestThreads }, tx);
        text = makePrompt(digestSource, loaded.artifact, version);
        const digestParts = await screenshotQueuedParts(loaded.artifact, digestSource.comments, target.sessionId, text, { capability, executor: tx });
        await tx.update(sessionLifecycleCommands).set({ payload: { ...pending.payload, text, parts: digestParts.length ? digestParts : undefined,
          artifactCommentDigest: { artifactId: payload.artifactId, threadIds: digestThreads, keys: [...state.keys, target.key],
            deliveries: [...state.deliveries, { job_id: job.jobId, target_key: target.key }] } }, updatedAt: new Date() })
          .where(eq(sessionLifecycleCommands.commandId, pending.commandId));
      }
    } else {
      const values = buildContinueSessionCommandValues({ source: 'system:artifact-comment', projectId: loaded.artifact.projectId,
        accountId: loaded.artifact.accountId, sessionId: target.sessionId, actorUserId: actor.userId, text, ...(imageParts.length ? { parts: imageParts } : {}), idempotencyKey: target.key,
        delivery: 'queue', placement: 'composer', bindTurnIdentity: !payload.callerSessionId, authorSessionId: payload.callerSessionId,
        ...(running ? { availableAt: new Date(Date.now() + 15_000) } : {}),
      });
      await tx.insert(sessionLifecycleCommands).values({ ...values, artifactId: payload.artifactId, payload: { ...values.payload,
        artifactCommentDelivery: { job_id: job.jobId, target_key: target.key },
        ...(running ? { artifactCommentDigest: { artifactId: payload.artifactId, threadIds: digestThreads, keys: [target.key], deliveries: [{ job_id: job.jobId, target_key: target.key }] } } : {}) } })
        .onConflictDoNothing({ target: sessionLifecycleCommands.idempotencyKey });
    }
    await markSent(tx, job, payload, target, loaded.artifact);
    const [command] = await tx.select({ idempotencyKey: sessionLifecycleCommands.idempotencyKey,
      availableAt: sessionLifecycleCommands.availableAt, status: sessionLifecycleCommands.status }).from(sessionLifecycleCommands)
      .where(and(eq(sessionLifecycleCommands.idempotencyKey, pending?.idempotencyKey ?? target.key),
        eq(sessionLifecycleCommands.artifactId, payload.artifactId), eq(sessionLifecycleCommands.projectId, loaded.artifact.projectId),
        eq(sessionLifecycleCommands.accountId, loaded.artifact.accountId)));
    return command?.status === 'queued' && command.idempotencyKey ? { idempotencyKey: command.idempotencyKey, availableAt: command.availableAt } : null;
  });
  target.status = 'sent';
  if (receipt) wakeArtifactCommentLifecycle(receipt);
}

function makePrompt(loaded: Awaited<ReturnType<typeof source>>, artifact: ArtifactRow, version: string) {
  const screenshots = new Map(screenshotReferences(artifact, loaded.comments, config.KORTIX_URL).map(image => [image.filename.split('.')[0]!, image.url]));
  return artifactCommentPrompt({ artifactId: artifact.artifactId, title: artifact.title, path: sharedPath(artifact), version }, loaded.threads.map((thread) => ({
    thread_id: thread.threadId, anchor: thread.anchor as ArtifactCommentAnchor,
    comments: loaded.comments.filter((comment) => comment.threadId === thread.threadId).map((comment) => ({
      body: comment.deletedAt ? '' : comment.body, ...(screenshots.has(comment.commentId) ? { screenshot_url: screenshots.get(comment.commentId)! } : {}), author_user_id: comment.authorUserId, author_session_id: comment.authorSessionId,
    })),
  })));
}

export async function rebuildArtifactCommentCreatePrompt(jobId: string, targetKey: string): Promise<string> {
  const [job] = await db.select().from(jobQueue).where(and(eq(jobQueue.jobId, jobId), eq(jobQueue.queue, AGENTS)));
  if (!job) throw invalid('The comment delivery no longer exists');
  const payload = job.payload as ArtifactCommentAgentPayload;
  const target = payload.targets?.find((entry) => entry.key === targetKey);
  if (!target || !target.created || target.status !== 'pending') throw invalid('The comment delivery changed');
  const loaded = await source(payload);
  if (!await artifactCommentOriginIsCurrent(loaded.artifact, payload.threadIds, target)) throw invalid('The agent mention was removed');
  if (payload.commentId && !target.implicit && !mentionRecipients(loaded.comment!.mentions).some((recipient) => recipient.recipientKey === target.recipientKey)) throw invalid('The agent mention was removed');
  const version = await entryVersion(loaded.artifact);
  if (!version) throw invalid('The Artifact entry no longer exists');
  return makePrompt(loaded, loaded.artifact, version);
}

export async function rebuildArtifactCommentContinuePrompt(row: Pick<typeof sessionLifecycleCommands.$inferSelect,
  'accountId' | 'projectId' | 'sessionId' | 'artifactId' | 'payload' | 'actorUserId' | 'idempotencyKey'>, onCurrentSource?: (loaded: Awaited<ReturnType<typeof source>>, text: string) => Promise<void>): Promise<string> {
  const digest = row.payload.artifactCommentDigest as { deliveries?: Array<{ job_id: string; target_key: string }> } | undefined;
  const references = digest?.deliveries ?? [row.payload.artifactCommentDelivery as { job_id: string; target_key: string }];
  if (!references.length || references.some((reference) => !reference)) throw invalid('The comment delivery context is missing');
  const { ArtifactCommentAuthorityError, revalidateArtifactCommentContinue } = await import('./comment-authority');
  const checked: Array<Awaited<ReturnType<typeof revalidateArtifactCommentContinue>>> = [];
  let refusal: unknown;
  for (const reference of references) {
    try { checked.push(await revalidateArtifactCommentContinue(row, reference)); }
    catch (error) {
      if (!(error instanceof ArtifactCommentAuthorityError) && !(error instanceof ArtifactCommentDeliveryError)) throw error;
      refusal ??= error;
      await reconcileRefusedDelivery(row, reference);
    }
  }
  if (!checked.length) throw refusal ?? invalid('The comment digest no longer has a recipient');
  try {
    const payload = checked[0]!.payload;
    if (checked.some((entry) => entry.payload.artifactId !== payload.artifactId)) throw invalid('The comment digest contains another Artifact');
    const threadIds = [...new Set(checked.flatMap((entry) => entry.payload.threadIds))];
    const loaded = await source({ ...payload, threadIds }, db, true);
    const version = await entryVersion(loaded.artifact);
    if (!version) throw invalid('The Artifact entry no longer exists');
    const text = makePrompt(loaded, loaded.artifact, version);
    await onCurrentSource?.(loaded, text);
    return text;
  } catch (error) {
    if (error instanceof ArtifactCommentDeliveryError || error instanceof ArtifactCommentScreenshotError && error.status === 413) for (const reference of references) await reconcileRefusedDelivery(row, reference, error instanceof ArtifactCommentScreenshotError ? SCREENSHOT_LIMIT_MESSAGE : FAILURE);
    throw error;
  }
}

async function reconcileRefusedDelivery(
  row: Pick<typeof sessionLifecycleCommands.$inferSelect, 'accountId' | 'projectId' | 'artifactId'>,
  reference: { job_id: string; target_key: string },
  message = FAILURE,
) {
  if (!row.artifactId || !reference || !isUuid(reference.job_id)) return;
  await db.transaction(async (tx) => {
    const [artifact] = await tx.select().from(artifacts).where(and(eq(artifacts.artifactId, row.artifactId!),
      eq(artifacts.projectId, row.projectId), eq(artifacts.accountId, row.accountId))).for('update');
    if (!artifact) return;
    const jobs = await tx.select().from(jobQueue).where(and(eq(jobQueue.queue, AGENTS), eq(jobQueue.artifactId, artifact.artifactId)))
      .orderBy(desc(jobQueue.createdAt), desc(jobQueue.jobId));
    const job = jobs.find((entry) => entry.jobId === reference.job_id);
    const payload = job?.payload as ArtifactCommentAgentPayload | undefined;
    const target = payload?.targets?.find((entry) => entry.key === reference.target_key);
    if (!payload || !target) return;
    const threads = await tx.select().from(artifactCommentThreads).where(and(eq(artifactCommentThreads.artifactId, artifact.artifactId),
      eq(artifactCommentThreads.projectId, artifact.projectId), inArray(artifactCommentThreads.threadId, payload.threadIds)));
    const [comment] = payload.commentId ? await tx.select().from(artifactComments).where(and(eq(artifactComments.commentId, payload.commentId),
      inArray(artifactComments.threadId, payload.threadIds))) : [];
    const removed = (!!payload.commentId && (!comment || !!comment.deletedAt)) || !await artifactCommentOriginIsCurrent(artifact, payload.threadIds, target, tx);
    for (const thread of threads) {
      const [root] = await tx.select({ deleted: artifactComments.deletedAt }).from(artifactComments).where(eq(artifactComments.threadId, thread.threadId))
        .orderBy(asc(artifactComments.createdAt), asc(artifactComments.commentId)).limit(1);
      if (!root || root.deleted) {
        await tx.update(artifactCommentThreads).set({ agentState: 'none', agentError: null, sentSessionId: null, sentAt: null })
          .where(eq(artifactCommentThreads.threadId, thread.threadId));
        continue;
      }
      if (thread.agentState === 'paused' && thread.agentError === null) continue;
      if (!removed) {
        await tx.update(artifactCommentThreads).set({ agentState: 'paused', agentError: message }).where(eq(artifactCommentThreads.threadId, thread.threadId));
        continue;
      }
      const remaining: ArtifactCommentTarget[] = [];
      for (const candidate of jobs) {
        const context = candidate.payload as ArtifactCommentAgentPayload;
        if (!context.threadIds?.includes(thread.threadId)) continue;
        const [sourceComment] = context.commentId ? await tx.select().from(artifactComments).where(and(eq(artifactComments.commentId, context.commentId),
          inArray(artifactComments.threadId, context.threadIds))) : [];
        if (context.commentId && (!sourceComment || sourceComment.deletedAt)) continue;
        for (const other of context.targets ?? []) {
          if (candidate.jobId === reference.job_id && other.key === reference.target_key) continue;
          if (other.status !== 'sent' && !(candidate.status === 'queued' && other.status === 'pending')) continue;
          if (await artifactCommentOriginIsCurrent(artifact, context.threadIds, other, tx)) remaining.push(other);
        }
      }
      const pending = remaining.some((entry) => entry.status === 'pending');
      const display = remaining[0];
      await tx.update(artifactCommentThreads).set({ agentState: pending ? 'pending' : remaining.length ? 'sent' : 'none', agentError: null,
        sentSessionId: display?.sessionId ?? null, ...(display ? {} : { sentAt: null }) }).where(eq(artifactCommentThreads.threadId, thread.threadId));
    }
  });
}

async function markSent(tx: Tx, job: Job, payload: ArtifactCommentAgentPayload, target: ArtifactCommentTarget, artifact: ArtifactRow) {
  const sent: ArtifactCommentAgentPayload = { ...payload, targets: payload.targets!.map((entry) => entry === target ? { ...entry, status: 'sent' } : entry) };
  await saveProgress(tx, job, sent);
  await updateThreadDeliveryState(tx, sent);
  for (const threadId of payload.threadIds) await recordArtifactEvent(tx, artifact,
    payload.callerSessionId ? { sessionId: payload.callerSessionId } : { userId: payload.actor.userId }, 'sent_to_agent', {
      thread_id: threadId, ...(payload.commentId ? { comment_id: payload.commentId } : {}), session_id: target.sessionId,
      agent_name: target.agentName, recipient_key: target.recipientKey, delivery_key: target.key,
      ...(target.originCommentId ? { origin_comment_id: target.originCommentId } : {}),
    });
}

export async function runArtifactCommentAgentJob(job: Job): Promise<void> {
  const payload = job.payload as ArtifactCommentAgentPayload;
  const loaded = await source(payload);
  await initializeTargets(job, payload, loaded);
  const { ArtifactCommentAuthorityError, authorizeArtifactCommentAgent, assertArtifactCommentDeliveryAccess } = await import('./comment-authority');
  let version: string | null = null;
  let text = '';
  let retry: unknown;
  for (const target of payload.targets!) {
    if (target.status !== 'pending') continue;
    const stillMentioned = (!payload.commentId || target.implicit || mentionRecipients(loaded.comment!.mentions).some((recipient) => recipient.recipientKey === target.recipientKey))
      && await artifactCommentOriginIsCurrent(loaded.artifact, payload.threadIds, target);
    if (!stillMentioned) {
      target.status = 'skipped';
      await db.transaction(async (tx) => { await saveProgress(tx, job, payload); await updateThreadDeliveryState(tx, payload); });
      continue;
    }
    try {
      let session = (await db.select().from(projectSessions).where(and(eq(projectSessions.accountId, loaded.artifact.accountId),
        eq(projectSessions.projectId, loaded.artifact.projectId), eq(projectSessions.sessionId, target.sessionId)))).at(0);
      const authority = await authorizeArtifactCommentAgent(payload.actor, loaded.project, target.agentName, session);
      if (authority.callerSessionId !== payload.callerSessionId) throw new ArtifactCommentAuthorityError();
      await assertArtifactCommentDeliveryAccess(authority.actor, loaded.artifact, authority.callerSessionId);
      if (!target.initialized || (!target.created && (!session || !authority.canPromptExisting))) {
        if (!target.created && session && !authority.canPromptExisting) target.createKey = undefined;
        await initializeTarget(job, payload, target, loaded, session, authority.canPromptExisting);
        if (session?.sessionId !== target.sessionId) session = undefined;
      }
      if (!version) {
        version = await entryVersion(loaded.artifact);
        if (!version) throw invalid('The Artifact entry no longer exists');
        text = makePrompt(loaded, loaded.artifact, version);
      }
      if (target.created || target.createKey) {
        await assertScreenshotReferences(loaded.artifact, screenshotReferences(loaded.artifact, loaded.comments, config.KORTIX_URL), text);
        const key = target.createKey ?? target.key;
        if (target.created) {
          const { createSession } = await import('../projects/surface');
          const result = await createSession({ source: 'system:artifact-comment', project: loaded.project, userId: authority.actor.userId,
            artifactId: loaded.artifact.artifactId,
            requestingPrincipalType: authority.actor.credential.kind === 'service_account' ? 'service_account' : 'human',
            body: { session_id: target.sessionId, agent_name: target.agentName, pending_prompt: { text, agent: target.agentName } },
            idempotencyKey: key, queuePolicy: 'always', parentActor: authority.actor, callerSessionId: authority.callerSessionId,
            inSession: !!authority.callerSessionId, metadata: { artifactCommentDelivery: { job_id: job.jobId, target_key: target.key } },
          });
          if (result.status === 'failed') {
            if (result.retryable) throw new Error('The agent session creation can be retried');
            throw invalid('The agent session could not be created');
          }
        }
        const [command] = await db.select({ status: sessionLifecycleCommands.status, idempotencyKey: sessionLifecycleCommands.idempotencyKey,
          availableAt: sessionLifecycleCommands.availableAt }).from(sessionLifecycleCommands)
          .where(and(eq(sessionLifecycleCommands.idempotencyKey, key), eq(sessionLifecycleCommands.artifactId, payload.artifactId),
            eq(sessionLifecycleCommands.projectId, loaded.artifact.projectId), eq(sessionLifecycleCommands.accountId, loaded.artifact.accountId)));
        if (command?.status === 'queued' && command.idempotencyKey) wakeArtifactCommentLifecycle({ idempotencyKey: command.idempotencyKey, availableAt: command.availableAt });
        if (command && ['failed', 'cancelled', 'dead_lettered'].includes(command.status)) throw invalid('The agent session could not be created');
        if (!session || command?.status !== 'succeeded') throw new Error('The agent session is still being created');
        if (target.created) { await db.transaction((tx) => markSent(tx, job, payload, target, loaded.artifact)); target.status = 'sent'; continue; }
      }
      if (!session || !authority.canPromptExisting) throw invalid('The agent session is no longer available to this commenter');
      await deliverToExisting(job, payload, target, loaded, authority.actor, text, version);
    } catch (error) {
      if (error instanceof ArtifactCommentDeliveryError && error.message === 'The comment delivery claim expired') throw error;
      const terminal = error instanceof ArtifactCommentDeliveryError || (error instanceof ArtifactCommentScreenshotError && error.status === 413) || (error instanceof Error && error.name === 'ArtifactCommentAuthorityError');
      if (terminal) {
        target.status = 'failed';
        if (error instanceof ArtifactCommentScreenshotError) target.errorCode = error.code;
        target.error = error instanceof ArtifactCommentScreenshotError && error.code === 'artifact_comment_screenshot_limit' ? SCREENSHOT_LIMIT_MESSAGE : FAILURE;
        await db.transaction(async (tx) => {
          await saveProgress(tx, job, payload);
          await updateThreadDeliveryState(tx, payload);
        });
      } else retry ??= error;
    }
  }
  if (payload.targets!.some((target) => target.status === 'pending')) throw retry ?? new Error('The agent session is still being created');
  if (payload.targets!.some((target) => target.status === 'failed')) throw invalid(FAILURE);
}

async function people(job: Job): Promise<void> {
  const { notifyArtifactComment } = await import('./comment-notifications');
  await notifyArtifactComment(job.payload as { artifactId: string; commentId: string });
}

async function agents(job: Job): Promise<void> {
  try { await runArtifactCommentAgentJob(job); }
  catch (error) {
    if (error instanceof ArtifactCommentDeliveryError && error.code === 'artifact_comment_paused') {
      await completeJob(job);
      return;
    }
    const terminal = error instanceof ArtifactCommentDeliveryError || (error instanceof Error && error.name === 'ArtifactCommentAuthorityError');
    if (terminal || job.attempts >= job.maxAttempts) {
      const payload = job.payload as ArtifactCommentAgentPayload;
      const failureMessage = payload.targets?.some(target => target.errorCode === 'artifact_comment_screenshot_limit') ? SCREENSHOT_LIMIT_MESSAGE : FAILURE;
      await db.transaction(async (tx) => {
        const [claim] = await tx.select({ id: jobQueue.jobId }).from(jobQueue).where(ownClaim(job)).for('update');
        if (!claim) return;
        await tx.update(artifactCommentThreads).set({ agentState: 'paused', agentError: failureMessage })
          .where(and(eq(artifactCommentThreads.artifactId, payload.artifactId), inArray(artifactCommentThreads.threadId, payload.threadIds)));
        if (terminal) await tx.update(jobQueue).set({ status: 'dead', lockedUntil: null, lastError: FAILURE }).where(ownClaim(job));
      });
    }
    throw new Error(FAILURE);
  }
}

registerJobHandler(PEOPLE, people, 5 * 60_000);
registerJobHandler(AGENTS, agents, 5 * 60_000);

export async function dispatchArtifactCommentJobs(key: string): Promise<void> {
  const jobs = await db.update(jobQueue).set({ attempts: sql`${jobQueue.attempts} + 1`, lockedUntil: sql`now() + interval '5 minutes'`, updatedAt: new Date() })
    .where(and(inArray(jobQueue.queue, [PEOPLE, AGENTS]), eq(jobQueue.jobKey, key), eq(jobQueue.status, 'queued'),
      sql`${jobQueue.runAt} <= now()`, sql`(${jobQueue.lockedUntil} is null or ${jobQueue.lockedUntil} < now())`)).returning();
  for (const job of jobs) {
    try { await (job.queue === PEOPLE ? people(job) : agents(job)); await completeJob(job); }
    catch { await failJob(job, new Error(job.queue === PEOPLE ? 'Artifact notification delivery failed' : FAILURE)); }
  }
}

export async function resolveArtifactCommentSendTarget(artifact: ArtifactRow, actor: Actor, callerSessionId: string | null, requestedAgent?: string) {
  const [project] = await db.select().from(projects).where(and(eq(projects.projectId, artifact.projectId), eq(projects.accountId, artifact.accountId)));
  if (!project) throw new ArtifactCommentDeliveryError(404, 'Project not found', 'not_found');
  let session = artifact.createdBySessionId ? (await db.select().from(projectSessions).where(and(eq(projectSessions.accountId, artifact.accountId),
    eq(projectSessions.projectId, artifact.projectId), eq(projectSessions.sessionId, artifact.createdBySessionId))))[0] : undefined;
  let agentName = requestedAgent ?? session?.agentName;
  if (!agentName) {
    const { loadProjectAgents } = await import('../projects/surface');
    const agents = await loadProjectAgents(project, { rethrowReadErrors: true });
    agentName = agents.defaultAgent ?? 'kortix';
  }
  if (!agentName) throw new ArtifactCommentDeliveryError(400, 'Choose an agent for this comment batch', 'artifact_comment_agent_required');
  if (session?.agentName !== agentName) session = undefined;
  const { ArtifactCommentAuthorityError, authorizeArtifactCommentAgent, assertArtifactCommentDeliveryAccess } = await import('./comment-authority');
  const authority = await authorizeArtifactCommentAgent(actor, project, agentName, session);
  if (authority.callerSessionId !== callerSessionId) throw new ArtifactCommentAuthorityError();
  await assertArtifactCommentDeliveryAccess(authority.actor, artifact, authority.callerSessionId);
  return { agentName, session, authority,
    descriptor: { kind: authority.canPromptExisting && session ? 'session' as const : 'new' as const,
      session_id: authority.canPromptExisting && session ? session.sessionId : null, agent_name: agentName } };
}

export async function sendArtifactCommentThreads(artifact: ArtifactRow, actor: Actor, callerSessionId: string | null,
  input: { thread_ids: string[]; batch_id?: string; agent?: string }) {
  const batch = input.batch_id ?? randomUUID();
  const key = `artifact-comments:batch:${batch}`;
  const threadIds = [...new Set(input.thread_ids)].sort();
  const payload: ArtifactCommentAgentPayload = { artifactId: artifact.artifactId, threadIds, actor, callerSessionId, recipients: [], manual: true };
  const currentSource = await source(payload);
  const { agentName, session } = await resolveArtifactCommentSendTarget(artifact, actor, callerSessionId, input.agent);
  const screenshots = screenshotReferences(artifact, currentSource.comments, config.KORTIX_URL);
  if (screenshots.length && (await screenshotTargetCapability(artifact.projectId, session?.sessionId)).mayNeedImages) {
    const version = await entryVersion(artifact);
    if (!version) throw invalid('The Artifact entry no longer exists');
    await assertScreenshotReferences(artifact, screenshots, makePrompt(currentSource, artifact, version));
  }
  payload.recipients = [{ recipientKey: session ? `session:${session.sessionId}` : `agent:${agentName}`, ...(session ? { sessionId: session.sessionId } : {}), agentName, implicit: true }];
  await db.transaction(async (tx) => {
    const [locked] = await tx.select({ id: artifacts.artifactId }).from(artifacts).where(eq(artifacts.artifactId, artifact.artifactId)).for('update');
    if (!locked) throw new ArtifactCommentDeliveryError(404, 'Artifact not found', 'not_found');
    await enqueueJobs(AGENTS, [{ key, payload }], { executor: tx, maxAttempts: MAX_ATTEMPTS, artifactId: artifact.artifactId });
    const [existing] = await tx.select().from(jobQueue).where(and(eq(jobQueue.queue, AGENTS), eq(jobQueue.jobKey, key)));
    const saved = existing!.payload as ArtifactCommentAgentPayload;
    if (saved.artifactId !== artifact.artifactId || saved.actor.userId !== actor.userId || saved.callerSessionId !== callerSessionId
      || JSON.stringify([...saved.threadIds].sort()) !== JSON.stringify(threadIds) || saved.recipients[0]?.agentName !== agentName) throw invalid('This batch id already names another handoff');
    if (!saved.targets) await tx.update(artifactCommentThreads).set({ agentState: 'pending', agentError: null }).where(and(eq(artifactCommentThreads.artifactId, artifact.artifactId), inArray(artifactCommentThreads.threadId, threadIds)));
  });
  await dispatchArtifactCommentJobs(key);
  let [job] = await db.select().from(jobQueue).where(and(eq(jobQueue.queue, AGENTS), eq(jobQueue.jobKey, key)));
  for (let attempt = 0; (!(job!.payload as ArtifactCommentAgentPayload).targets || (job!.payload as ArtifactCommentAgentPayload).targets?.[0]?.initialized === false)
    && job!.status === 'queued' && attempt < 100; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    [job] = await db.select().from(jobQueue).where(and(eq(jobQueue.queue, AGENTS), eq(jobQueue.jobKey, key)));
  }
  const target = (job!.payload as ArtifactCommentAgentPayload).targets?.[0];
  if (target?.status === 'failed' && target.errorCode === 'artifact_comment_screenshot_limit') {
    const { ARTIFACT_SCREENSHOT_DELIVERY_LIMITS } = await import('./comment-screenshot-parts');
    throw new ArtifactCommentScreenshotError(413, target.errorCode, SCREENSHOT_LIMIT_MESSAGE, ARTIFACT_SCREENSHOT_DELIVERY_LIMITS);
  }
  if (!target || target.initialized === false || target.status === 'failed' || target.status === 'skipped') throw invalid('The comment batch could not be sent');
  return { session_id: target.sessionId, created: target.created };
}
