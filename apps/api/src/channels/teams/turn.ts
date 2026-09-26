import { and, eq, lt, sql } from 'drizzle-orm';
import { chatThreads, chatTurnStreams } from '@kortix/db';
import { db } from '../../shared/db';
import { runWorkerTick } from '../../shared/audit-scope';
import { config } from '../../config';
import { classifyTurnError, type TurnErrorInfo } from '../slack/errors';
import { sessionWebUrl } from '../slack/util';
import type { StreamTaskChunk } from '../slack-api';
import { sendCard, sendText, updateCard } from '../teams-api';
import { loadTeamsServiceUrlForProject, saveTeamsServiceUrl } from '../install-store';
import { TRUNCATION_NOTE, buildAnswerCard, buildFinalCard, buildNoticeCard, buildPlanCard, fitBodyToCard } from './cards';
import { mrkdwnToTeamsMarkdown } from './markdown';
import { STREAM_TTL_MS, STALE_AFTER_MS } from './app';
import type { TeamsActivity, TeamsChannelRef, TeamsConversationRef, TeamsLiveTurn } from './types';
import { conversationScope } from './util';

const LIVE_PLAN_TITLE = 'Working on it…';

function refOf(handle: TeamsLiveTurn): TeamsConversationRef {
  return {
    serviceUrl: handle.serviceUrl,
    conversationId: handle.conversationId,
    botId: handle.botId,
    fromId: handle.fromId,
    tenantId: handle.tenantId,
    projectId: handle.projectId,
  };
}

function rowToHandle(row: typeof chatTurnStreams.$inferSelect): TeamsLiveTurn {
  const ref = (row.channelRef ?? {}) as TeamsChannelRef;
  return {
    conversationId: row.channel,
    tenantId: row.teamId,
    serviceUrl: ref.serviceUrl ?? '',
    botId: ref.botId,
    fromId: ref.fromId,
    triggerActivityId: row.triggerTs,
    messageActivityId: row.messageTs ?? '',
    steps: (row.steps as StreamTaskChunk[]) ?? [],
    expiry: new Date(row.expiresAt).getTime(),
    finalized: row.finalized,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).getTime() : undefined,
    projectId: row.projectId,
    sessionId: row.sessionId,
    originatingActivity: row.originatingEvent as TeamsActivity,
    ...(Array.isArray(ref.repliedTurns) ? { repliedTurns: ref.repliedTurns } : {}),
  };
}

/**
 * `expires_at` is not a reaper here — identical reasoning to the Slack side, see
 * channels/slack/turn.ts loadTurn. `STREAM_TTL_MS` is refreshed only by a `slack
 * step` relay, so any quiet stretch of real agent work longer than 15 minutes
 * deleted the row and silently dropped every later step and the final answer.
 * The GC sweep below is the reaper: keyed on `updated_at`, and it posts before
 * it deletes.
 */
export async function loadTurn(sessionId: string): Promise<TeamsLiveTurn | null> {
  if (!sessionId) return null;
  const [row] = await db
    .select()
    .from(chatTurnStreams)
    .where(eq(chatTurnStreams.sessionId, sessionId))
    .limit(1);
  if (!row || !row.channelRef) return null;
  return rowToHandle(row);
}

export async function saveTurn(handle: TeamsLiveTurn): Promise<void> {
  if (!handle.sessionId) return;
  const channelRef: TeamsChannelRef = {
    platform: 'teams',
    serviceUrl: handle.serviceUrl,
    conversationId: handle.conversationId,
    botId: handle.botId,
    fromId: handle.fromId,
  };
  const values = {
    sessionId: handle.sessionId,
    projectId: handle.projectId,
    teamId: handle.tenantId,
    channel: handle.conversationId,
    triggerTs: handle.triggerActivityId,
    messageTs: handle.messageActivityId || null,
    finalized: handle.finalized,
    steps: handle.steps,
    originatingEvent: handle.originatingActivity as unknown,
    channelRef: channelRef as unknown,
    expiresAt: new Date(handle.expiry),
    updatedAt: new Date(),
  };
  await db
    .insert(chatTurnStreams)
    .values(values as typeof chatTurnStreams.$inferInsert)
    .onConflictDoUpdate({ target: chatTurnStreams.sessionId, set: values as Partial<typeof chatTurnStreams.$inferInsert> });
}

export async function deleteTurn(sessionId: string): Promise<void> {
  if (!sessionId) return;
  await db.delete(chatTurnStreams).where(eq(chatTurnStreams.sessionId, sessionId));
}

export async function claimFinalize(sessionId: string): Promise<boolean> {
  const rows = await db
    .update(chatTurnStreams)
    .set({ finalized: true, updatedAt: new Date() })
    .where(and(eq(chatTurnStreams.sessionId, sessionId), eq(chatTurnStreams.finalized, false)))
    .returning({ sessionId: chatTurnStreams.sessionId });
  return rows.length > 0;
}

export async function startTurn(
  projectId: string,
  tenantId: string,
  activity: TeamsActivity,
): Promise<TeamsLiveTurn | null> {
  const serviceUrl = activity.serviceUrl;
  const conversationId = activity.conversation?.id;
  if (!serviceUrl || !conversationId || !activity.id) return null;

  const ref: TeamsConversationRef = {
    serviceUrl,
    conversationId,
    botId: activity.recipient?.id,
    fromId: activity.from?.id,
    tenantId,
    projectId,
  };
  // No typing indicator: the live card is the acknowledgement, and an
  // indicator sent alongside it renders as stray dots under the card.
  const t0 = Date.now();
  const messageActivityId = (await sendCard(ref, buildPlanCard(LIVE_PLAN_TITLE, []))) ?? '';
  console.info('[teams-webhook] live card posted', {
    projectId,
    ms: Date.now() - t0,
    posted: Boolean(messageActivityId),
  });

  return {
    conversationId,
    tenantId,
    serviceUrl,
    botId: activity.recipient?.id,
    fromId: activity.from?.id,
    triggerActivityId: activity.id,
    messageActivityId,
    steps: [],
    expiry: Date.now() + STREAM_TTL_MS,
    finalized: false,
    projectId,
    sessionId: '',
    originatingActivity: activity,
  };
}

/**
 * Turn a just-posted live card into a one-line notice. Used when a follow-up
 * arrives while a turn is already streaming for the session: the running
 * stream keeps its own card; this one must not become a second, competing
 * "Working on it…".
 */
/**
 * Close a turn that stopped without ever finishing — the agent's sandbox died,
 * the run was cancelled mid-deploy, anything that skips `relayTurnEnd`. Same
 * copy the stale sweeper uses, but applied the moment the next message
 * arrives instead of up to 30 minutes later. Safe to call concurrently with
 * the sweeper: the finalize claim decides one winner.
 */
export async function closeAbandonedTurn(handle: TeamsLiveTurn): Promise<void> {
  if (!(await claimFinalize(handle.sessionId))) return;
  await finalizeTurn(handle, { error: '_This run ended without a reply._' });
  await deleteTurn(handle.sessionId);
}

export async function noticeOnLiveCard(handle: TeamsLiveTurn, text: string): Promise<void> {
  if (!handle.messageActivityId) return;
  await updateCard(refOf(handle), handle.messageActivityId, buildNoticeCard(text));
}

async function repaintPlan(handle: TeamsLiveTurn): Promise<void> {
  if (!handle.messageActivityId) return;
  await updateCard(
    refOf(handle),
    handle.messageActivityId,
    // `sessionId` is what puts Stop on the card, and it is empty until the
    // session exists — there is nothing to stop before then.
    buildPlanCard(LIVE_PLAN_TITLE, handle.steps, handle.sessionId || undefined),
  );
}

/**
 * Repaint the live card once the turn knows its session, so Stop appears
 * without waiting for the agent's first step. Best effort: a card that cannot
 * be updated still gains the button on the next step.
 */
export async function showStopOnLiveCard(handle: TeamsLiveTurn | null): Promise<void> {
  if (!handle || !handle.messageActivityId || !handle.sessionId || handle.finalized) return;
  try {
    await repaintPlan(handle);
  } catch (err) {
    console.warn('[teams-webhook] could not repaint the live card with Stop', {
      sessionId: handle.sessionId,
      err: (err as Error)?.message,
    });
  }
}

/**
 * The runtime turn tokens live for this session right now — the ledger that
 * `GET .../turn` and inbox admission read. Empty when there is no running box,
 * no ledger, or it cannot be read. Imported lazily: the channel modules keep
 * no static edge into the lifecycle code.
 */
async function liveRuntimeTurnTokens(sessionId: string): Promise<string[]> {
  try {
    const [{ sessionSandboxes }, { RUNNING_SANDBOX_STATUSES, storedSandboxTurns }] = await Promise.all([
      import('@kortix/db'),
      import('../../projects/sandbox-turn-lifecycle'),
    ]);
    const [box] = await db
      .select({ status: sessionSandboxes.status, metadata: sessionSandboxes.metadata })
      .from(sessionSandboxes)
      .where(eq(sessionSandboxes.sessionId, sessionId))
      .limit(1);
    if (!box || !RUNNING_SANDBOX_STATUSES.has(box.status)) return [];
    return storedSandboxTurns(box.metadata).map((t) => t.token);
  } catch {
    return [];
  }
}

/**
 * Close the turn because the agent replied — an answer, a question card, a
 * review card — and keep the row as a marker of which runtime turn replied.
 *
 * Deleting the row instead made any later relay from the SAME run (a
 * `teams send` after a question, a stray step after the answer) open a second
 * card. The marker drops those; the runtime's own end-of-turn relay removes
 * it, and a relay from a newer runtime turn replaces it (`reopenTurn`).
 */
export async function markTurnReplied(sessionId: string): Promise<void> {
  const tokens = await liveRuntimeTurnTokens(sessionId);
  await db
    .update(chatTurnStreams)
    .set({
      finalized: true,
      // Merged in SQL, never read-modify-write (learnings, 2026-09-22).
      channelRef: sql`coalesce(${chatTurnStreams.channelRef}, '{}'::jsonb) || jsonb_build_object('repliedTurns', ${JSON.stringify(tokens)}::jsonb)`,
      updatedAt: new Date(),
    })
    .where(eq(chatTurnStreams.sessionId, sessionId));
}

/**
 * Is a relay that finds this replied-turn marker from the run that replied?
 * Only when the runtime's live turns are all ones the marker recorded. A turn
 * the marker never saw is new work — a message sent while the run was going,
 * a queued start — and its end-of-turn relay for the old run may simply have
 * been lost. Unknown (no ledger) counts as "same run": a stray card is the
 * cheaper mistake only when nothing says otherwise.
 */
async function replyMarkerCoversRuntime(handle: TeamsLiveTurn): Promise<boolean> {
  const replied = handle.repliedTurns ?? [];
  const live = await liveRuntimeTurnTokens(handle.sessionId);
  if (live.length === 0) return true;
  return live.every((token) => replied.includes(token));
}

/**
 * The conversation a session still owns, as a reference the bot can post to.
 * Null when the conversation was detached from it (`/new`) or the project has
 * no service URL on record yet.
 */
export async function conversationRefForSession(sessionId: string): Promise<TeamsConversationRef | null> {
  if (!sessionId) return null;
  const [thread] = await db
    .select({
      projectId: chatThreads.projectId,
      tenantId: chatThreads.workspaceId,
      conversationId: chatThreads.threadId,
    })
    .from(chatThreads)
    .where(and(eq(chatThreads.platform, 'teams'), eq(chatThreads.sessionId, sessionId)))
    .limit(1);
  if (!thread) return null;
  const serviceUrl = await loadTeamsServiceUrlForProject(thread.projectId);
  if (!serviceUrl) return null;
  return { serviceUrl, conversationId: thread.conversationId, tenantId: thread.tenantId, projectId: thread.projectId };
}

/**
 * Open a new turn for a session whose work is arriving with no card to land
 * in.
 *
 * A card is opened by the Teams message that starts a prompt. Some prompts run
 * without one: a message sent while another run was going (its card became
 * "I'll take this after the current step"), a start that was queued (its card
 * said so and closed), a turn the sweeper closed while the agent was still
 * working. Their `teams step` and `teams send` found no turn, the CLI told the
 * agent the turn was over, and the reply never reached Teams at all. Slack's
 * agent recovers by posting with `--channel/--thread`; Teams had no path.
 *
 * The new row carries no card yet: the first step posts the live card and an
 * answer posts an answer card, exactly as for a turn opened by a message. Only
 * a session that still owns its conversation qualifies — after `/new` the old
 * session must not post into the chat that left it. Two relays racing here
 * share one row: the insert does nothing if a turn already exists.
 */
export async function reopenTurn(sessionId: string, replaceReplied = false): Promise<TeamsLiveTurn | null> {
  const ref = await conversationRefForSession(sessionId);
  if (!ref) return null;
  const now = Date.now();
  const handle: TeamsLiveTurn = {
    conversationId: ref.conversationId,
    tenantId: ref.tenantId ?? '',
    serviceUrl: ref.serviceUrl,
    triggerActivityId: `reopened-${now}`,
    messageActivityId: '',
    steps: [],
    expiry: now + STREAM_TTL_MS,
    finalized: false,
    projectId: ref.projectId ?? '',
    sessionId,
    originatingActivity: {} as TeamsActivity,
  };
  const channelRef: TeamsChannelRef = { platform: 'teams', serviceUrl: ref.serviceUrl, conversationId: ref.conversationId };
  const values = {
    sessionId,
    projectId: handle.projectId,
    teamId: handle.tenantId,
    channel: handle.conversationId,
    triggerTs: handle.triggerActivityId,
    messageTs: null,
    finalized: false,
    steps: [],
    originatingEvent: {},
    channelRef: channelRef as unknown,
    expiresAt: new Date(handle.expiry),
    updatedAt: new Date(now),
  } as typeof chatTurnStreams.$inferInsert;
  const insert = db.insert(chatTurnStreams).values(values);
  const inserted = await (replaceReplied
    ? insert.onConflictDoUpdate({
        target: chatTurnStreams.sessionId,
        set: values,
        // Only a replied-turn marker is replaced; a live turn is never
        // overwritten, and a turn being closed right now is left alone.
        setWhere: sql`${chatTurnStreams.finalized} = true AND (${chatTurnStreams.channelRef} -> 'repliedTurns') IS NOT NULL`,
      })
    : insert.onConflictDoNothing({ target: chatTurnStreams.sessionId })
  ).returning({ sessionId: chatTurnStreams.sessionId });
  if (inserted.length === 0) return loadTurn(sessionId);
  console.info('[teams-webhook] opened a turn for work that had no card', { sessionId });
  return handle;
}

export async function relayTurnStep(
  sessionId: string,
  title: string,
  opts: {
    detail?: string;
    outputForPrev?: string;
    sourcesForPrev?: Array<{ url: string; text: string }>;
  } = {},
): Promise<boolean> {
  const handle = await turnForRelay(sessionId);
  if (!handle || handle.finalized) {
    if (!handle) {
      console.warn('[teams-webhook] turn-stream step dropped — no open turn for session', {
        sessionId,
        title: title.slice(0, 80),
      });
    }
    return false;
  }

  if (!handle.messageActivityId) {
    const firstStep: StreamTaskChunk = {
      type: 'task_update',
      id: 'step-0',
      title: title.slice(0, 200),
      status: 'in_progress',
    };
    if (opts.detail) firstStep.details = opts.detail.slice(0, 500);
    const activityId = await sendCard(
      refOf(handle),
      buildPlanCard(LIVE_PLAN_TITLE, [firstStep], handle.sessionId || undefined),
    );
    if (!activityId) return false;
    handle.messageActivityId = activityId;
    handle.steps = [firstStep];
    handle.expiry = Date.now() + STREAM_TTL_MS;
    await saveTurn(handle);
    return true;
  }

  const last = handle.steps[handle.steps.length - 1];
  if (last && last.status === 'in_progress') {
    last.status = 'complete';
    if (opts.outputForPrev) last.output = opts.outputForPrev.slice(0, 500);
    if (opts.sourcesForPrev && opts.sourcesForPrev.length > 0) {
      last.sources = opts.sourcesForPrev.slice(0, 8).map((s) => ({
        type: 'url',
        url: s.url,
        text: s.text.slice(0, 80),
      }));
    }
  }
  const next: StreamTaskChunk = {
    type: 'task_update',
    id: `step-${handle.steps.length}`,
    title: title.slice(0, 200),
    status: 'in_progress',
  };
  if (opts.detail) next.details = opts.detail.slice(0, 500);
  handle.steps.push(next);
  handle.expiry = Date.now() + STREAM_TTL_MS;
  await repaintPlan(handle);
  await saveTurn(handle);
  return true;
}

export async function relayTurnAnswer(
  sessionId: string,
  text: string,
  card?: Record<string, unknown>,
): Promise<boolean> {
  const handle = await turnForRelay(sessionId);
  if (!handle || handle.finalized) return false;
  if (!(await claimFinalize(sessionId))) return false;
  await finalizeTurn(handle, { answer: text, card });
  await markTurnReplied(sessionId);
  return true;
}

/**
 * The turn a step or an answer lands in.
 *
 * - An open turn: that one.
 * - No row: this prompt started without a card — open one.
 * - A replied-turn marker: a stray from the run that replied is dropped (the
 *   finalized handle comes back); work from a newer runtime turn replaces it.
 * - Any other finalized row is a turn being closed right now, and is never
 *   reopened under it.
 */
async function turnForRelay(sessionId: string): Promise<TeamsLiveTurn | null> {
  const handle = await loadTurn(sessionId);
  if (!handle) return reopenTurn(sessionId);
  if (handle.finalized && handle.repliedTurns && !(await replyMarkerCoversRuntime(handle))) {
    return reopenTurn(sessionId, true);
  }
  return handle;
}

export async function relayTurnEnd(
  sessionId: string,
  status: 'idle' | 'error' = 'idle',
  errorInfo?: TurnErrorInfo,
): Promise<boolean> {
  const handle = await loadTurn(sessionId);
  if (!handle) return false;
  if (handle.finalized) {
    // The run that replied has ended: nothing can stray from it any more.
    if (handle.repliedTurns) await deleteTurn(sessionId);
    return false;
  }
  if (!(await claimFinalize(sessionId))) return false;
  if (status === 'error') {
    const classified = classifyTurnError(errorInfo);
    // The classifier is Slack's, so its copy is Slack's dialect. Translate at
    // the boundary rather than forking the copy — see mrkdwnToTeamsMarkdown.
    await finalizeTurn(
      handle,
      classified.aborted
        ? {}
        : { error: mrkdwnToTeamsMarkdown(classified.text), title: classified.title },
    );
  } else {
    await finalizeTurn(handle, {});
  }
  await deleteTurn(sessionId);
  return true;
}

export async function finalizeTurn(
  handle: TeamsLiveTurn,
  opts: {
    answer?: string;
    error?: string;
    title?: string;
    card?: Record<string, unknown>;
    /**
     * The step in flight neither finished nor failed — a deliberate Stop, or a
     * turn that ended by ASKING rather than answering. Both get the neutral
     * glyph; `complete` would claim work that never happened.
     */
    unfinished?: boolean;
  },
): Promise<void> {
  if (handle.finalized && handle.messageActivityId === '' && !opts.answer && !opts.error && !opts.card) return;
  const hasContent = Boolean(opts.answer || opts.error || opts.card);
  // A bound on the work below, not the delivered length: `fitBodyToCard`
  // decides that from the card's real size.
  const raw = opts.answer ?? opts.error ?? '';
  const body = raw.length > MAX_BODY_CHARS ? raw.slice(0, MAX_BODY_CHARS) : raw;
  const title = opts.title ?? (opts.error ? 'Run failed' : 'Task complete');
  const sessionUrl =
    handle.projectId && handle.sessionId
      ? sessionWebUrl(config.FRONTEND_URL, handle.projectId, handle.sessionId)
      : undefined;
  const ref = refOf(handle);

  // Did the answer reach the conversation? `updateCard` and `sendCard` report
  // a refusal by returning, not throwing — and a refused final card used to
  // leave the live card on its last step with the answer gone.
  let delivered = false;
  try {
    if (opts.card) {
      const answer = buildAnswerCard(body, sessionUrl, opts.card);
      delivered = handle.messageActivityId
        ? await updateCard(ref, handle.messageActivityId, answer)
        : Boolean(await sendCard(ref, answer));
    } else if (handle.messageActivityId) {
      const last = handle.steps[handle.steps.length - 1];
      if (last && last.status === 'in_progress') {
        // An unfinished step gets the neutral glyph. `complete` would claim
        // work that never finished, and `error` paints a red ✗ over something
        // the user chose to end, or over a question waiting on them.
        last.status = opts.unfinished ? 'pending' : opts.error ? 'error' : 'complete';
      }
      const render = (b: string) => buildFinalCard({ title, steps: handle.steps, body: b, sessionUrl });
      const fitted = fitBodyToCard(body, render);
      delivered = await updateCard(ref, handle.messageActivityId, render(fitted.body));
    } else if (hasContent) {
      const render = (b: string) => buildAnswerCard(b, sessionUrl);
      delivered = Boolean(await sendCard(ref, render(fitBodyToCard(body, render).body)));
    } else {
      delivered = true;
    }
  } catch (err) {
    console.warn('[teams-webhook] finalize render failed', {
      sessionId: handle.sessionId,
      err: (err as Error)?.message,
    });
  }
  if (delivered || !hasContent) return;

  // Teams refused the card — too large, or a card the agent built that Teams
  // will not render. The answer must not vanish: post it as text, which Teams
  // takes where it refuses a card, and close the live card so it does not
  // read as still working. Slack has had this fallback since its own answers
  // outgrew one section (slack/turn.ts plainFallback).
  console.warn('[teams-webhook] final card refused; posting the answer as text', { sessionId: handle.sessionId });
  if (handle.messageActivityId) {
    await updateCard(
      ref,
      handle.messageActivityId,
      buildFinalCard({ title, steps: handle.steps, body: 'The answer is in the next message.', sessionUrl }),
    ).catch(() => false);
  }
  const text = fitTextMessage(body || 'The agent replied with a card Teams could not show.', sessionUrl);
  const posted = await sendText(ref, text).catch(() => null);
  if (!posted) console.warn('[teams-webhook] answer could not be delivered as text either', { sessionId: handle.sessionId });
}

/** Past this the fitting loop costs more than any card could hold. */
const MAX_BODY_CHARS = 60_000;

/** A plain-text message stays under Teams' ~28 KB limit with the same margin as a card. */
const TEXT_BUDGET_BYTES = 20_000;

function fitTextMessage(body: string, sessionUrl?: string): string {
  const link = sessionUrl ? `\n\n[Open session in Kortix ↗](${sessionUrl})` : '';
  let out = body;
  if (Buffer.byteLength(out + link, 'utf8') > TEXT_BUDGET_BYTES) {
    // Characters, not bytes, are what slice counts: shrink until the bytes fit.
    while (out.length > 0 && Buffer.byteLength(`${out}\n\n${TRUNCATION_NOTE}${link}`, 'utf8') > TEXT_BUDGET_BYTES) {
      out = out.slice(0, Math.floor(out.length * 0.9));
    }
    out = `${out.trimEnd()}\n\n${TRUNCATION_NOTE}`;
  }
  return `${out}${link}`;
}

export function buildTeamsTurnEnv(tenantId: string, activity: TeamsActivity): Record<string, string> {
  const env: Record<string, string> = {};
  if (tenantId) env.MS_TEAMS_TENANT_ID = tenantId;
  if (activity.conversation?.id) env.MS_TEAMS_CONVERSATION_ID = activity.conversation.id;
  if (activity.serviceUrl) env.MS_TEAMS_SERVICE_URL = activity.serviceUrl;
  if (activity.from?.id) env.MS_TEAMS_USER_ID = activity.from.id;
  // Scope decides how `teams send --file` delivers: a consent card only works
  // in personal chats; a channel needs an inline image or a team-drive link.
  env.MS_TEAMS_CONVERSATION_TYPE = conversationScope(activity);
  if (activity.channelData?.team?.aadGroupId) env.MS_TEAMS_TEAM_GROUP_ID = activity.channelData.team.aadGroupId;
  return env;
}

// The conversation serviceUrl is stable for a tenant; every inbound message
// used to re-encrypt and re-upsert it. One write per distinct value per
// process is enough — a restart simply writes it once more.
const persistedServiceUrl = new Map<string, string>();

export async function persistServiceUrl(projectId: string, serviceUrl?: string): Promise<void> {
  if (!serviceUrl || persistedServiceUrl.get(projectId) === serviceUrl) return;
  persistedServiceUrl.set(projectId, serviceUrl);
  await saveTeamsServiceUrl(projectId, serviceUrl).catch(() => {
    persistedServiceUrl.delete(projectId);
  });
}

/** One pass of the stale-turn sweep. Exported for tests; the interval below runs it. */
export async function sweepStaleTeamsTurns(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_AFTER_MS);
  // A replied-turn marker whose end-of-turn relay never came.
  await db
    .delete(chatTurnStreams)
    .where(
      and(
        eq(chatTurnStreams.finalized, true),
        lt(chatTurnStreams.updatedAt, cutoff),
        sql`${chatTurnStreams.channelRef}->>'platform' = 'teams'`,
        sql`(${chatTurnStreams.channelRef} -> 'repliedTurns') IS NOT NULL`,
      ),
    );
  const stale = await db
    .select()
    .from(chatTurnStreams)
    .where(
      and(
        eq(chatTurnStreams.finalized, false),
        lt(chatTurnStreams.updatedAt, cutoff),
        sql`${chatTurnStreams.channelRef}->>'platform' = 'teams'`,
      ),
    )
    .limit(50);
  for (const row of stale) {
    // Thirty minutes without a step is not proof of a dead run: one long
    // command posts nothing while it works. This used to close the card
    // AND abort the runtime turn, killing healthy work. The runtime's own
    // turn ledger decides; a live run keeps its card, touched so it is not
    // reconsidered for another 30 minutes.
    if (await runtimeStillWorking(row.sessionId)) {
      await db
        .update(chatTurnStreams)
        .set({ updatedAt: new Date() })
        .where(and(eq(chatTurnStreams.sessionId, row.sessionId), eq(chatTurnStreams.finalized, false)));
      continue;
    }
    if (!(await claimFinalize(row.sessionId))) continue;
    await finalizeTurn(rowToHandle(row), { error: '_This run ended without a reply._' });
    await deleteTurn(row.sessionId);
    await abortDeadRuntimeTurn(row.sessionId);
  }
}

setInterval(() => {
  runWorkerTick('teams-turn-gc', sweepStaleTeamsTurns).catch((err) => console.warn('[teams-webhook] gc tick failed', err));
}, 5 * 60 * 1000).unref();

/**
 * Does the runtime's turn ledger still hold a live turn for this session?
 * Unknown counts as no: a sweep that cannot tell must still clear a card
 * that would otherwise swallow the conversation. Imported lazily for the
 * same reason as the abort below.
 */
async function runtimeStillWorking(sessionId: string): Promise<boolean> {
  try {
    const { sessionHoldsLiveTurn } = await import('../../projects/session-lifecycle/inbox-admission');
    return await sessionHoldsLiveTurn(sessionId);
  } catch {
    return false;
  }
}

/**
 * Closing the card is not ending the run. A turn this sweep reaps has been
 * silent for 30 minutes, but OpenCode can still hold its assistant message
 * OPEN — and while it does, every later prompt in that conversation is
 * accepted and never runs. Seen on dev 2026-09-19: two messages vanished that
 * way over two days. Imported lazily so the channel modules keep no static
 * edge into the session-lifecycle engine.
 */
async function abortDeadRuntimeTurn(sessionId: string): Promise<void> {
  try {
    const { abortRuntimeTurn } = await import('../../projects/session-lifecycle/abort-runtime-turn');
    await abortRuntimeTurn(sessionId);
  } catch {
    /* housekeeping: a runtime that cannot be reached needs no abort */
  }
}
