import { and, eq, lt } from 'drizzle-orm';
import { chatEventDedup, chatTurnStreams, projectSessions } from '@kortix/db';
import { db } from '../../shared/db';
import { registerSessionFailureNotifier } from '../../shared/session-failure-notifier';
import { config } from '../../config';
import { sessionWebUrl } from './util';
import { markdownToMrkdwn, mrkdwnToRichTextElements } from './mrkdwn';
import { loadSlackTokenForProject } from '../install-store';
import {
  addReaction,
  joinChannel,
  postBlocks,
  postMessage,
  removeReaction,
  startStream,
  stopStream,
  updateBlocks,
  type StreamTaskChunk,
} from '../slack-api';
import { STREAM_TTL_MS, WORKING_EMOJI } from './app';
import { classifyTurnError, type TurnErrorInfo } from './errors';
import type { SlackEvent, LiveTurn } from './types';

export function rowToHandle(row: typeof chatTurnStreams.$inferSelect, token: string): LiveTurn {
  return {
    channel: row.channel,
    ts: row.messageTs ?? '',
    token,
    triggerTs: row.triggerTs,
    steps: (row.steps as StreamTaskChunk[]) ?? [],
    expiry: new Date(row.expiresAt).getTime(),
    finalized: row.finalized,
    projectId: row.projectId,
    sessionId: row.sessionId,
    teamId: row.teamId,
    originatingEvent: row.originatingEvent as SlackEvent,
  };
}

/**
 * Hydrate a DB row into a usable handle (loads the bot token for its project).
 *
 * `expires_at` IS NOT A REAPER HERE. It used to delete the row and return null
 * the moment it passed, and `STREAM_TTL_MS` is 15 minutes that ONLY a `slack
 * step` refreshes (see relayTurnStep) — the agent's own work refreshes nothing.
 * So a run that thought for 16 minutes, or sat in one long install, silently
 * lost its stream: every later step AND the final `slack send` found no row and
 * were dropped, leaving the thread frozen on one stale step while the agent
 * worked on.
 *
 * PROD 2026-09-05, session e58ddd55 (Slack thread 1788612689.109129 in
 * C0BQCDKMTGX). `slack step` at 12:54:42, next at 13:19:22 — a 24m40s gap — so
 * the row was reaped at 13:09:42 and the following five steps plus the answer
 * went nowhere while the agent ran two more hours. The agent noticed the silence
 * and started its own `while sleep 200; do slack step` keepalive at 13:37; by
 * then there was nothing left to keep alive. Three incident threads that week
 * (d91f2ff5, d08cccb4, 11f9e9e9) died the same way and read in Slack as
 * "Kortix ignored the incident".
 *
 * The GC sweep below is the reaper, and the honest one: it is keyed on
 * `updated_at` (30 minutes with no relay at all) and it POSTS before it deletes.
 * Reaping here raced that sweep and won silently. `expires_at` stays written for
 * bookkeeping and its index; nothing reads it as authority any more.
 */
export async function loadTurn(sessionId: string): Promise<LiveTurn | null> {
  if (!sessionId) return null;
  const [row] = await db
    .select()
    .from(chatTurnStreams)
    .where(eq(chatTurnStreams.sessionId, sessionId))
    .limit(1);
  if (!row) return null;
  const token = await loadSlackTokenForProject(row.projectId);
  if (!token) return null;
  return rowToHandle(row, token);
}

/** Upsert the handle (minus the token) so the next relay — on any replica — sees it. */
export async function saveTurn(handle: LiveTurn): Promise<void> {
  if (!handle.sessionId) return;
  const values = {
    sessionId: handle.sessionId,
    projectId: handle.projectId,
    teamId: handle.teamId,
    channel: handle.channel,
    triggerTs: handle.triggerTs,
    messageTs: handle.ts || null,
    finalized: handle.finalized,
    steps: handle.steps,
    originatingEvent: handle.originatingEvent as unknown,
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

/**
 * Atomically claim a turn for finalization so it's closed exactly once — the
 * `slack send` answer relay, a late `session.idle`/`session.error` relay, and the
 * stale-turn GC sweep can all race. Returns true to the winner.
 */
export async function claimFinalize(sessionId: string): Promise<boolean> {
  const rows = await db
    .update(chatTurnStreams)
    .set({ finalized: true, updatedAt: new Date() })
    .where(and(eq(chatTurnStreams.sessionId, sessionId), eq(chatTurnStreams.finalized, false)))
    .returning({ sessionId: chatTurnStreams.sessionId });
  return rows.length > 0;
}

// Plan title shown while the turn runs; the finalize pass overwrites it with
// "Task complete" / "Run failed".
const LIVE_PLAN_TITLE = 'Working on it…';

// GC sweep — NOT the old streaming watchdog. There is no heartbeat and no Slack
// auto-fail to fight: the plan is a plain message we only ever chat.update, and
// an edited message never goes stale. This only (1) sweeps turns that went
// silent for an inactivity window so long the sandbox clearly died before it
// could close out (updated_at bumps on every relay, so a long-but-live turn is
// never reaped), and (2) GCs the inbound-event dedup table. Runs every 5 min
// (it's housekeeping, not a keep-alive); claimFinalize keeps it single-winner.
const STALE_AFTER_MS = 30 * 60 * 1000;

setInterval(() => {
  void (async () => {
    try {
      const now = new Date();
      const cutoff = new Date(now.getTime() - STALE_AFTER_MS);
      const stale = await db
        .select()
        .from(chatTurnStreams)
        .where(and(eq(chatTurnStreams.finalized, false), lt(chatTurnStreams.updatedAt, cutoff)))
        .limit(50);
      for (const row of stale) {
        if (row.channelRef) continue;
        if (!(await claimFinalize(row.sessionId))) continue;
        const token = await loadSlackTokenForProject(row.projectId);
        if (token) {
          // Last-resort close for a turn that went silent for 30 min — the
          // sandbox never relayed an end (it died, hung, or stalled retrying).
          // Be honest about why rather than a bare "ended without a reply".
          await finalizeTurn(rowToHandle(row, token), {
            error:
              ':warning: *This run was closed after 30 minutes of silence* — it may have stalled or run out of credits.',
            title: 'Run timed out',
          });
        } else {
          // No token (app uninstalled / token rotated) → we can't post or clear
          // the ⏳. Reap the row anyway (below) and surface it so a dead install
          // is observable instead of silently dropping every turn.
          console.warn('[slack-webhook] gc: no Slack token for project — cannot finalize turn', {
            projectId: row.projectId,
            teamId: row.teamId,
            sessionId: row.sessionId,
          });
        }
        await deleteTurn(row.sessionId);
      }
      await db.delete(chatEventDedup).where(lt(chatEventDedup.expiresAt, now));
    } catch (err) {
      console.warn('[slack-webhook] gc tick failed', err);
    }
  })();
}, 5 * 60 * 1000).unref();

export async function startTurn(
  projectId: string,
  teamId: string,
  event: SlackEvent,
  // firstStepTitle was the eager "Spinning up a sandbox" placeholder that
  // appeared in the plan block before the agent did anything. We no longer
  // pre-open the plan stream — the parameter stays for ABI but is ignored.
  _unusedFirstStepTitle?: string,
): Promise<LiveTurn | null> {
  if (!event.channel || !event.ts || !event.user) return null;
  const token = await loadSlackTokenForProject(projectId);
  if (!token) {
    // No bot token (app uninstalled / token rotated) → we can't even react. Log
    // it so a dead install is observable rather than the bot silently ignoring
    // every mention.
    console.warn('[slack-webhook] startTurn: no Slack token for project — cannot start turn', {
      projectId,
      teamId,
      channel: event.channel,
    });
    return null;
  }
  await joinChannel(token, event.channel);
  // The only eager feedback is a ⏳ reaction on the user's own message — a
  // lightweight "received, working on it" signal that lives ON their message,
  // not a standalone bot post. We deliberately DON'T post an "On it…" message:
  // a turn that ends without `slack send` (e.g. nothing worth replying to) then
  // leaves the thread untouched, and `session.idle` clears the reaction. The
  // plan stream is opened lazily on the first `slack step`; the final answer is
  // posted by `slack send`.
  await addReaction(token, event.channel, event.ts, WORKING_EMOJI);

  return {
    channel: event.channel,
    token,
    triggerTs: event.ts,
    expiry: Date.now() + STREAM_TTL_MS,
    finalized: false,
    projectId,
    sessionId: '',
    teamId,
    originatingEvent: event,
    ts: '',
    steps: [],
  };
}

// Create the plan-checklist message on the first `slack step`. We open a native
// streaming message (so it's a plan-block-capable assistant message) and
// IMMEDIATELY close it, then only ever chat.update it. Because no stream is ever
// left open, Slack's 5-minute idle auto-fail ("Something went wrong") can never
// trigger — which is what let us delete the heartbeat + watchdog entirely. The
// native checklist look is unchanged.
export async function openPlanMessage(handle: LiveTurn, firstStep: StreamTaskChunk): Promise<boolean> {
  if (handle.ts) return true;
  const ev = handle.originatingEvent;
  const threadTs = ev.thread_ts ?? ev.ts;
  if (!ev.channel || !ev.user || !threadTs) return false;
  const ts = await startStream(handle.token, ev.channel, threadTs, ev.user, handle.teamId, [firstStep]);
  if (!ts) return false;
  handle.ts = ts;
  handle.steps = [firstStep];
  // Close the stream the instant it exists → from here it is a plain message we
  // only chat.update, so it can never go stale.
  await stopStream(handle.token, handle.channel, ts, [
    { type: 'task_update', id: firstStep.id, title: firstStep.title, status: firstStep.status },
  ]);
  await repaintLivePlan(handle);
  return true;
}

// Render the current plan state into the (static) plan message via chat.update.
// This is now the ONLY render path — every step and the final close go through
// it; there is no streaming-append path left.
export async function repaintLivePlan(handle: LiveTurn): Promise<void> {
  if (!handle.ts) return;
  await updateBlocks(handle.token, handle.channel, handle.ts, LIVE_PLAN_TITLE, [
    { type: 'plan', title: LIVE_PLAN_TITLE, tasks: buildPlanTasks(handle.steps) },
  ]);
}

export function buildSlackTurnEnv(teamId: string, event: SlackEvent): Record<string, string> {
  const env: Record<string, string> = {};
  if (teamId) env.SLACK_TEAM_ID = teamId;
  if (event.channel) env.SLACK_CHANNEL_ID = event.channel;
  if (event.thread_ts ?? event.ts) env.SLACK_THREAD_TS = (event.thread_ts ?? event.ts)!;
  if (event.ts) env.SLACK_TRIGGER_TS = event.ts;
  if (event.user) env.SLACK_USER_ID = event.user;
  return env;
}

// Close out a turn's live stream. Three shapes of finalization:
//   • answer/error/blocks present → render that as the reply.
//   • nothing present (a "silent" finalize, e.g. the agent ended its turn
//     without `slack send`) → DON'T invent a "_Done._" message. If a plan was
//     streaming, just close it cleanly; if nothing was ever posted, leave the
//     thread untouched. This is what stops an orphaned "On it…" from lingering.
export async function finalizeTurn(
  handle: LiveTurn,
  opts: { answer?: string; error?: string; blocks?: unknown[]; title?: string },
): Promise<void> {
  if (handle.finalized) return;
  handle.finalized = true;
  const hasContent = Boolean(opts.answer || opts.error || (opts.blocks && opts.blocks.length > 0));
  const rawBody = opts.answer ?? opts.error ?? '';
  const truncated = rawBody.length > MAX_BODY;
  const body = rawBody.slice(0, MAX_BODY);
  const ev = handle.originatingEvent;
  const threadRoot = ev.thread_ts ?? ev.ts ?? handle.triggerTs;

  // Did the content actually reach the thread? We gate the ✅ on this so we never
  // imply a reply that was rejected, and we fall back to a plain post when a
  // block render fails — a long answer dropped into one Block Kit section can be
  // rejected (sections cap at 3000 chars), and that must not silently vanish.
  let rendered = false;

  // Render the result — BEST-EFFORT. The row is already claimed-finalized by the
  // time we get here, so a Slack API hiccup while rendering must not throw: that
  // would skip the caller's deleteTurn AND (before this) strand the ⏳ forever,
  // since the GC only sweeps UN-finalized rows. We log and fall through to always
  // clear the ⏳ below.
  try {
    if (handle.ts && handle.steps.length > 0) {
      // A plan message exists — close out the last in-progress step and render the
      // final plan (+ answer/error) into it via chat.update.
      const last = handle.steps[handle.steps.length - 1];
      if (last && last.status === 'in_progress') last.status = opts.error ? 'error' : 'complete';
      rendered = await updateBlocks(
        handle.token,
        handle.channel,
        handle.ts,
        planTitleFor(opts),
        buildFinalPlanBlocks(handle, body, opts, truncated),
      );
      // chat.update rejected the blocks (e.g. invalid_blocks) — don't lose real
      // content; post it fresh as plain text so it still lands in the thread.
      if (!rendered && hasContent) {
        const ts = await postMessage(handle.token, handle.channel, plainFallback(handle, body), threadRoot);
        rendered = ts != null;
      }
    } else if (hasContent) {
      // The agent posted no `slack step` (no plan message) but we have a reply or
      // an error to surface — post it fresh in-thread.
      if (opts.blocks && opts.blocks.length > 0) {
        const ts = await postBlocks(handle.token, handle.channel, body, opts.blocks, threadRoot);
        rendered = ts != null;
        if (!rendered) {
          const f = await postMessage(handle.token, handle.channel, plainFallback(handle, body), threadRoot);
          rendered = f != null;
        }
      } else if (opts.error && handle.projectId && handle.sessionId) {
        // An error with no plan stream: post the failure copy WITH an "Open
        // session" footer so the thread always has a way to see what went wrong
        // (the plan path already appends this footer; mirror it here).
        const url = sessionWebUrl(config.FRONTEND_URL, handle.projectId, handle.sessionId);
        const ts = await postBlocks(
          handle.token,
          handle.channel,
          body,
          [
            ...toSectionBlocks(body, truncated),
            { type: 'context', elements: [{ type: 'mrkdwn', text: `<${url}|Open session in Kortix ↗>` }] },
          ],
          threadRoot,
        );
        rendered = ts != null;
        if (!rendered) {
          const f = await postMessage(handle.token, handle.channel, plainFallback(handle, body), threadRoot);
          rendered = f != null;
        }
      } else {
        // Plain post already — slackApiCall retries transient failures, so there's
        // no block-vs-text fallback to add here.
        const ts = await postMessage(handle.token, handle.channel, body, threadRoot);
        rendered = ts != null;
      }
    }
    // A silent finalize with no plan message and no content leaves the thread
    // untouched — we just clear the ⏳ below. The ✅ is reserved for a real answer
    // that ACTUALLY posted (never imply a reply that was rejected).
    if (opts.answer && !opts.error && rendered) {
      await addReaction(handle.token, handle.channel, handle.triggerTs, 'white_check_mark');
    }
  } catch (err) {
    console.warn('[slack-webhook] finalize render failed (turn still closed)', { sessionId: handle.sessionId, err: (err as Error)?.message });
  }
  // ALWAYS clear the ⏳ — even if the render above failed.
  await removeReaction(handle.token, handle.channel, handle.triggerTs, WORKING_EMOJI).catch(() => {});
}

// Slack Block Kit caps a section's text at 3000 chars and the outer message has
// its own limits, so we never drop the whole answer into one section. Cap the
// body, split it across a few sections on newline boundaries, and flag overflow.
const MAX_BODY = 11000;
const SECTION_LIMIT = 2900;
const MAX_SECTIONS = 5;

function toSectionBlocks(body: string, truncated = false): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  let rest = body;
  while (rest.length > 0 && blocks.length < MAX_SECTIONS) {
    let take = Math.min(rest.length, SECTION_LIMIT);
    if (rest.length > SECTION_LIMIT) {
      const nl = rest.lastIndexOf('\n', SECTION_LIMIT);
      if (nl > SECTION_LIMIT * 0.6) take = nl;
    }
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: rest.slice(0, take) } });
    rest = rest.slice(take);
  }
  if (truncated || rest.length > 0) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '_… truncated — open the session for the full output._' }],
    });
  }
  return blocks;
}

// Plain-text rendering of the body for the chat.postMessage fallback when a block
// render is rejected. postMessage's text field allows far more than a section, so
// the full (already ≤MAX_BODY) body fits; append the session link inline.
function plainFallback(handle: LiveTurn, body: string): string {
  if (handle.projectId && handle.sessionId) {
    const url = sessionWebUrl(config.FRONTEND_URL, handle.projectId, handle.sessionId);
    return `${body}\n\n<${url}|Open session in Kortix ↗>`;
  }
  return body;
}

function planTitleFor(opts: { answer?: string; error?: string; title?: string }): string {
  if (opts.title) return opts.title;
  if (opts.error) return 'Run failed';
  return 'Task complete';
}

// Render stream task chunks as `plan` block tasks for chat.update repaints
// (both the mid-run dead-stream repaint and the final close).
function buildPlanTasks(steps: StreamTaskChunk[]): Array<Record<string, unknown>> {
  return steps.map((s) => {
    const task: Record<string, unknown> = {
      task_id: s.id,
      title: s.title,
      status: s.status,
    };
    // details/output are mrkdwn strings (the skill instructs `<url|label>`), but
    // chat.update rich_text renders plain text elements literally — tokenize
    // into real link/bold/code elements so repaints don't show raw syntax.
    if (s.details) {
      task.details = {
        type: 'rich_text',
        elements: [{ type: 'rich_text_section', elements: mrkdwnToRichTextElements(s.details) }],
      };
    }
    if (s.output) {
      task.output = {
        type: 'rich_text',
        elements: [{ type: 'rich_text_section', elements: mrkdwnToRichTextElements(s.output) }],
      };
    }
    if (s.sources && s.sources.length > 0) task.sources = s.sources;
    return task;
  });
}

function buildFinalPlanBlocks(
  handle: LiveTurn,
  body: string,
  opts: { answer?: string; error?: string; blocks?: unknown[]; title?: string },
  truncated = false,
): unknown[] {
  const blocks: Array<Record<string, unknown>> = [
    {
      type: 'plan',
      title: planTitleFor(opts),
      tasks: buildPlanTasks(handle.steps),
    },
  ];
  if (opts.blocks && opts.blocks.length > 0) {
    for (const b of opts.blocks) blocks.push(b as Record<string, unknown>);
  } else if (body) {
    // Chunk into ≤3000-char sections so a long answer isn't rejected wholesale.
    for (const b of toSectionBlocks(body, truncated)) blocks.push(b);
  }
  // Footer: a link to open this session on the web. Lets anyone in the thread
  // jump straight to the full session (logs, files, diff) in Kortix.
  if (handle.projectId && handle.sessionId) {
    const url = sessionWebUrl(config.FRONTEND_URL, handle.projectId, handle.sessionId);
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `<${url}|Open session in Kortix ↗>` }],
    });
  }
  return blocks;
}

// ── Turn-stream relays ──────────────────────────────────────────────────────
// Driven by the in-sandbox agent CLI (POST /turn-stream: `step`/`answer`) and by
// the sandbox's opencode session.idle/error watcher (`end`). They own the live
// in-thread message lifecycle, so they live with the rest of it here in turn.ts.

export async function relayTurnStep(
  sessionId: string,
  title: string,
  opts: {
    detail?: string;
    outputForPrev?: string;
    sourcesForPrev?: Array<{ url: string; text: string }>;
  } = {},
): Promise<boolean> {
  const handle = await loadTurn(sessionId);
  if (!handle || handle.finalized) {
    // A FINALIZED turn is the expected, benign tail: the agent emitted a `slack
    // step` after `slack send` (or session.idle/error) had already closed the
    // turn. Drop it silently — this used to flood the logs whenever duplicate
    // concurrent runs raced, which the inbound-message exactly-once gate now
    // prevents. A MISSING row is the only genuinely-interesting case (a step
    // arrived with no turn ever opened), so keep a quiet signal just for that.
    if (!handle) {
      console.warn('[slack-webhook] turn-stream step dropped — no open turn for session', {
        sessionId,
        title: title.slice(0, 80),
      });
    }
    return false;
  }

  // First `slack step` → create the plan-checklist message.
  if (!handle.ts) {
    const firstStep: StreamTaskChunk = {
      type: 'task_update',
      id: 'step-0',
      title: title.slice(0, 200),
      status: 'in_progress',
    };
    if (opts.detail) firstStep.details = markdownToMrkdwn(opts.detail).slice(0, 500);
    const opened = await openPlanMessage(handle, firstStep);
    if (!opened) return false;
    handle.expiry = Date.now() + STREAM_TTL_MS;
    await saveTurn(handle);
    return true;
  }

  // Subsequent step → mark the previous one complete (with its output/sources),
  // append the new one, and repaint the whole plan via chat.update.
  const last = handle.steps[handle.steps.length - 1];
  if (last && last.status === 'in_progress') {
    last.status = 'complete';
    if (opts.outputForPrev) last.output = markdownToMrkdwn(opts.outputForPrev).slice(0, 500);
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
  if (opts.detail) next.details = markdownToMrkdwn(opts.detail).slice(0, 500);
  handle.steps.push(next);
  handle.expiry = Date.now() + STREAM_TTL_MS;
  await repaintLivePlan(handle);
  await saveTurn(handle);
  return true;
}

export async function relayTurnAnswer(
  sessionId: string,
  text: string,
  blocks?: unknown[],
): Promise<boolean> {
  const handle = await loadTurn(sessionId);
  // NO ROW AT ALL → the turn was closed and deleted (the 30-minute GC sweep)
  // while the run was still going. The answer is real and the thread is still
  // waiting for it, so deliver it anyway instead of returning false into an HTTP
  // 200 the agent reads as "sent". See postAnswerWithoutTurn.
  if (!handle) return postAnswerWithoutTurn(sessionId, text, blocks);
  // A FINALIZED row is a turn already closed WITH its reply — a duplicate
  // `slack send`, or a `session.idle` that won the race. Stay quiet.
  if (handle.finalized) return false;
  // Win the finalize race against a late session.idle/error relay (or a duplicate
  // send) so the turn is closed exactly once.
  if (!(await claimFinalize(sessionId))) return false;
  await finalizeTurn(handle, { answer: markdownToMrkdwn(text), blocks });
  await deleteTurn(sessionId);
  return true;
}

// ── Last-resort answer delivery, with no turn row left ────────────────────────
// The row can legitimately be gone by the time the agent answers: the GC closes
// a turn after 30 minutes with no relay, posts "Run timed out", and deletes it.
// The RUN does not stop — prod 2026-09-04 session d08cccb4 posted three steps,
// went quiet, was closed at 30 minutes, and only finished at 09:06:28, 2h58m
// after it started. `relayTurnAnswer` found no handle, returned false, and the
// route answered the sandbox HTTP 200 `{ok:false}` (projects/routes/r4.ts), so
// the agent believed it had replied and the thread never saw a word of it.
//
// A Slack-started session carries everything needed to reach its own thread in
// `project_sessions.metadata.slack` (channel + thread_ts, written at create time
// in channels/slack/session.ts), so the answer can always be posted. A session
// from any other source has no `metadata.slack` and is left alone.
const ANSWER_RESCUE_TTL_MS = STREAM_TTL_MS;

// One rescue per session per TTL, so a duplicate `slack send` cannot post the
// answer twice. The window is safe: a row must live at least STREAM_TTL_MS
// before anything can reap it, so two genuine rescues are always further apart
// than this claim.
async function claimAnswerRescue(sessionId: string): Promise<boolean> {
  try {
    const inserted = await db
      .insert(chatEventDedup)
      .values({
        eventId: `slack:answerrescue:${sessionId}`,
        expiresAt: new Date(Date.now() + ANSWER_RESCUE_TTL_MS),
      })
      .onConflictDoNothing({ target: chatEventDedup.eventId })
      .returning({ eventId: chatEventDedup.eventId });
    return inserted.length > 0;
  } catch (err) {
    // Fail CLOSED. The whole point is to not post twice into a thread someone is
    // reading; a dropped rescue is still recoverable from the session link.
    console.warn('[slack-webhook] answer-rescue claim failed (suppressing)', err);
    return false;
  }
}

/**
 * Post an agent answer into its Slack thread when no turn row exists.
 * Returns true only when Slack accepted the message.
 */
export async function postAnswerWithoutTurn(
  sessionId: string,
  text: string,
  blocks?: unknown[],
): Promise<boolean> {
  const [row] = await db
    .select({ projectId: projectSessions.projectId, metadata: projectSessions.metadata })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  if (!row) return false;
  const slack = (row.metadata as { slack?: { channel?: string; thread_ts?: string } } | null)?.slack;
  const channel = slack?.channel;
  const threadTs = slack?.thread_ts;
  if (!channel || !threadTs) return false; // not a Slack-started session
  const token = await loadSlackTokenForProject(row.projectId);
  if (!token) return false;
  if (!(await claimAnswerRescue(sessionId))) return false;

  const rendered = markdownToMrkdwn(text);
  const truncated = rendered.length > MAX_BODY;
  const body = rendered.slice(0, MAX_BODY);
  const url = sessionWebUrl(config.FRONTEND_URL, row.projectId, sessionId);
  const footer = { type: 'context', elements: [{ type: 'mrkdwn', text: `<${url}|Open session in Kortix ↗>` }] };
  const finalBlocks =
    blocks && blocks.length > 0 ? [...blocks, footer] : [...toSectionBlocks(body, truncated), footer];

  const ts = await postBlocks(token, channel, body, finalBlocks, threadTs);
  if (ts) return true;
  // Block render rejected (a section caps at 3000 chars) — never lose the answer.
  const fallback = await postMessage(token, channel, `${body}\n\n<${url}|Open session in Kortix ↗>`, threadTs);
  return fallback != null;
}

// Called when the agent's turn ends — opencode `session.idle` (finished) or
// `session.error` (died) on the ROOT session, relayed by the sandbox. The
// sandbox already filters to the root by opencode's parentID before relaying, so
// we finalize unconditionally: there is NO server-side pin re-check. Comparing
// the relayed id against a possibly-stale DB pin is exactly what used to drop a
// real turn's idle and leave the ⏳ spinning forever. If the agent already
// replied via `slack send`, claimFinalize makes this a no-op. Idle closes
// silently (finalizeTurn's silent path); error surfaces an honest failure line.
export async function relayTurnEnd(
  sessionId: string,
  status: 'idle' | 'error' = 'idle',
  errorInfo?: TurnErrorInfo,
): Promise<boolean> {
  const handle = await loadTurn(sessionId);
  if (!handle) {
    // No open turn — the row was finalized/expired/GC'd before this arrived. A
    // dropped IDLE is the benign tail of an already-answered turn, but a dropped
    // ERROR means we lost a real failure signal, so surface that one.
    if (status === 'error') {
      console.warn('[slack-webhook] turn-end ERROR relay dropped — no open turn for session', { sessionId });
    }
    return false;
  }
  if (handle.finalized) return false;
  if (!(await claimFinalize(sessionId))) return false;
  if (status === 'error') {
    // Turn the opencode error into honest, specific copy (out of credits /
    // usage limit / provider auth / the real error), not a blank failure line.
    const classified = classifyTurnError(errorInfo);
    await finalizeTurn(
      handle,
      // A user-initiated stop is not a failure — close quietly (retitle the plan,
      // no alarming body) instead of posting red failure copy.
      classified.aborted
        ? { title: classified.title }
        : { error: classified.text, title: classified.title },
    );
  } else {
    await finalizeTurn(handle, {});
  }
  await deleteTurn(sessionId);
  return true;
}

// A session this thread was waiting on died during async provisioning (provider
// capacity, git-auth, generic). The agent never ran, so no step/answer/`end`
// ever arrives — without this the ⏳ sits until the 30-min GC closes it with the
// wrong reason. The platform already classified a friendly message, so post it
// AS-IS (don't re-run classifyTurnError on it). Registered as the global session-
// failure notifier; a no-op for non-Slack sessions (no turn row to load).
export async function relayProvisioningFailure(sessionId: string, message: string): Promise<boolean> {
  const handle = await loadTurn(sessionId);
  if (!handle || handle.finalized) return false;
  if (!(await claimFinalize(sessionId))) return false;
  const detail = (message ?? '').trim().slice(0, 400) || 'Provisioning failed before the run could start.';
  await finalizeTurn(handle, { error: `:warning: *I couldn't start this run.* ${detail}`, title: "Couldn't start" });
  await deleteTurn(sessionId);
  return true;
}

// Wire the relay into the platform's provisioning-failure hook (dependency-
// inverted so platform/ never imports channels/). Runs once when this module is
// first imported — which is at server boot, since the Slack app mounts it.
registerSessionFailureNotifier(relayProvisioningFailure);
