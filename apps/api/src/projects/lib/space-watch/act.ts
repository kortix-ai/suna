/**
 * The space watcher at a session's turn end (flag `spaces_proactive`),
 * called off the turn's path from `peer-messages/service.ts`
 * (`onPeerTurnEnded`):
 *
 * - A top-level thread of a watched space finished a turn: one
 *   `turn_finished` line (its title, its agent, the start of its answer).
 * - The watcher itself finished a turn: its answer is ONE decision
 *   (`parseWatcherDecision`), carried out here, in its own space only, for
 *   the person it works for, through the space post path (`space-posts.ts`)
 *   with that person's rights:
 *   - `quiet`: nothing;
 *   - `post`: a top-level message from the agent in the space's chat;
 *   - `start_thread`: that message, then the task posted into its thread
 *     with `ask`, so the thread's agent (the router with `chat_front`) does
 *     the work in a normal thread;
 *   - `ask`: the question as a message that mentions the person, and a
 *     parked question on the watcher surfaced on that thread: Review and
 *     "Needs you" show it, and the answer comes back to the watcher.
 *   The answer's message id is claimed first (`claimDecision`): a repeated
 *   turn-end report acts once.
 */
import { projectSessions } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { logger } from '../../../lib/logger';
import { db } from '../../../shared/db';
import { lastTurnAnswer } from '../../peer-messages/service';
import { createSession } from '../../session-lifecycle';
import { askExpiresAt } from '../session-asks';
import { recordPendingQuestion } from '../pending-questions';
import type { ProjectRow } from '../serializers';
import { postIntoSpace, type StartThreadSpec } from '../space-posts';
import { resolveUserIdentities } from '../user-identity';
import { sessionTitleFromMetadata } from '../session-title-placeholder';
import { WATCHER_POST_METADATA_KEY } from './keys';
import { askOf, eventLine, parseWatcherDecision, type WatcherDecision } from './policy';
import { claimDecision, proactiveOn, readWatcher, recordSpaceEvent, watcherOfSession, type WatcherRow } from './store';
import { projectsView } from '../../../workspaces/rows';

/** A thread title from a post: its first line, at most 60 characters. */
function postTitle(text: string): string {
  const line = text.split('\n').find((part) => part.trim())?.trim() ?? text.trim();
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/** Never throws. */
export async function onSpaceSessionTurnEnded(sessionId: string): Promise<void> {
  try {
    const watcher = await watcherOfSession(sessionId);
    if (watcher) {
      await actOnWatcherAnswer(watcher, sessionId);
      return;
    }
    await recordThreadTurn(sessionId);
  } catch (error) {
    logger.warn('[space-watch] turn-end work failed', { session_id: sessionId, error: error instanceof Error ? error.message : String(error) });
  }
}

/** A watched space's top-level thread finished a turn: one feed line. */
async function recordThreadTurn(sessionId: string): Promise<void> {
  const [row] = await db
    .select({ spaceId: projectSessions.spaceId, parent: projectSessions.parentSessionId, agentName: projectSessions.agentName, metadata: projectSessions.metadata })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  if (!row?.spaceId || row.parent) return;
  const watch = await readWatcher(row.spaceId);
  if (!watch?.enabled) return;
  const answer = await lastTurnAnswer(sessionId);
  if (!answer?.text.trim()) return;
  const title = sessionTitleFromMetadata(row.metadata);
  await recordSpaceEvent({
    spaceId: row.spaceId,
    kind: 'turn_finished',
    line: eventLine({ kind: 'turn_finished', threadId: sessionId, title, result: answer.text, agent: row.agentName }, new Date()),
    dedupeKey: `turn:${sessionId}:${answer.id ?? answer.text.slice(0, 80)}`,
  });
}

/** Carry out the watcher's answer. */
async function actOnWatcherAnswer(watch: WatcherRow, sessionId: string): Promise<void> {
  const [project] = await db.select().from(projectsView).where(eq(projectsView.projectId, watch.projectId)).limit(1);
  if (!watch.enabled || !project || !proactiveOn(project.metadata)) {
    logger.info('[space-watch] answer ignored: the watcher is off', { space_id: watch.spaceId, session_id: sessionId });
    return;
  }
  const answer = await lastTurnAnswer(sessionId);
  if (!answer) return;
  const { decision, invalid } = parseWatcherDecision(answer.text);
  if (!(await claimDecision(watch.spaceId, answer.id ?? `text:${answer.text.slice(0, 120)}`))) return;
  if (invalid) logger.warn('[space-watch] the watcher answered no valid decision; staying quiet', { space_id: watch.spaceId, session_id: sessionId });
  logger.info('[space-watch] decision', { space_id: watch.spaceId, session_id: sessionId, action: decision.action, ...(decision.action === 'quiet' && decision.why ? { why: decision.why.slice(0, 120) } : {}) });
  if (decision.action === 'quiet') return;
  await carryOut({ project, watch, sessionId, decision, decisionId: answer.id ?? sessionId });
}

/** The person's mention token: their display name as a slug, else their email's local part. */
export async function mentionOf(userId: string): Promise<string | null> {
  const who = (await resolveUserIdentities([userId])).get(userId);
  const name = who?.displayName?.trim();
  if (name) return `@${name.toLowerCase().replace(/[^a-z0-9._@+-]+/g, '-').replace(/^-+|-+$/g, '')}`;
  const local = who?.email?.split('@')[0];
  return local ? `@${local.toLowerCase()}` : null;
}

async function carryOut(input: {
  project: ProjectRow;
  watch: WatcherRow;
  sessionId: string;
  decision: Exclude<WatcherDecision, { action: 'quiet' }>;
  decisionId: string;
}): Promise<void> {
  const { project, watch, sessionId, decision } = input;
  const startThread = async (spec: StartThreadSpec, text: string) => {
    const result = await createSession({
      source: 'system:chat-post',
      project,
      userId: spec.person,
      requestingPrincipalType: 'human',
      body: { agent_name: spec.agentName, space_id: spec.spaceId },
      metadata: { ...spec.metadata, name: postTitle(text), [WATCHER_POST_METADATA_KEY]: true },
      visibility: spec.visibility,
      inSession: false,
      callerSessionId: null,
      idempotencyKey: `space-watch-post:${watch.spaceId}:${input.decisionId}`,
    });
    if (result.error) return { error: result.error };
    return { sessionId: result.row?.sessionId ?? result.sessionId ?? null };
  };
  const post = async (text: string, threadId: string | null, ask: boolean) => {
    const outcome = await postIntoSpace({
      project,
      callerSessionId: sessionId,
      spaceId: watch.spaceId,
      text,
      threadId,
      ask,
      actor: null,
      // The watcher is the platform's; the person's own rights still decide every prompt (`mayPromptSessions`).
      agentMayPrompt: true,
      startThread: (spec) => startThread(spec, text),
    });
    if ('createError' in outcome) {
      logger.warn('[space-watch] the post was refused', { space_id: watch.spaceId, status: outcome.createError.status });
      return null;
    }
    if (outcome.status !== 201) {
      logger.warn('[space-watch] the post was refused', { space_id: watch.spaceId, status: outcome.status, code: outcome.body.code });
      return null;
    }
    return String(outcome.body.session_id);
  };

  if (decision.action === 'post') {
    const thread = await post(decision.text, null, false);
    logger.info('[space-watch] posted', { space_id: watch.spaceId, thread_id: thread });
    return;
  }
  if (decision.action === 'start_thread') {
    const thread = await post(decision.text, null, false);
    if (!thread) return;
    const asked = await post(decision.task, thread, true);
    logger.info('[space-watch] started a thread', { space_id: watch.spaceId, thread_id: thread, task_delivered: !!asked });
    return;
  }
  const ask = askOf(decision);
  const person = decision.person?.trim() || (await mentionOf(watch.ownerUserId)) || '';
  const thread = await post(`${person ? `${person} ` : ''}${ask.question}`.trim(), null, false);
  if (!thread) return;
  await recordPendingQuestion({
    accountId: project.accountId,
    projectId: project.projectId,
    sessionId,
    requestId: `space-watch:${input.decisionId}`,
    questions: [{ question: ask.question, header: ask.header, options: ask.options, custom: true }],
    parkable: true,
    surfaceSessionId: thread,
    expiresAt: askExpiresAt(),
  });
  logger.info('[space-watch] asked', { space_id: watch.spaceId, thread_id: thread });
}

/** People joined a watched channel: one line. Never throws. */
export async function recordMembersJoined(spaceId: string, userIds: readonly string[]): Promise<void> {
  if (userIds.length === 0) return;
  try {
    const watch = await readWatcher(spaceId);
    if (!watch?.enabled) return;
    const identities = await resolveUserIdentities([...userIds]);
    const names = userIds.map((id) => identities.get(id)?.displayName?.trim() || identities.get(id)?.email?.split('@')[0] || 'A member');
    const now = new Date();
    await recordSpaceEvent({
      spaceId,
      kind: 'member_joined',
      line: eventLine({ kind: 'member_joined', names }, now),
      dedupeKey: `members:${[...userIds].sort().join(',')}:${now.toISOString().slice(0, 16)}`,
    });
  } catch (error) {
    logger.warn('[space-watch] the join was not recorded', { space_id: spaceId, error: error instanceof Error ? error.message : String(error) });
  }
}

/** Agents were added to a watched channel: one line. Never throws. */
export async function recordAgentsJoined(spaceId: string, before: readonly string[], after: readonly string[]): Promise<void> {
  const added = after.filter((name) => !before.includes(name));
  if (added.length === 0) return;
  try {
    const now = new Date();
    await recordSpaceEvent({
      spaceId,
      kind: 'agent_joined',
      line: eventLine({ kind: 'agent_joined', names: added }, now),
      dedupeKey: `agents:${added.join(',')}:${now.toISOString().slice(0, 16)}`,
    });
  } catch (error) {
    logger.warn('[space-watch] the agent change was not recorded', { space_id: spaceId, error: error instanceof Error ? error.message : String(error) });
  }
}

