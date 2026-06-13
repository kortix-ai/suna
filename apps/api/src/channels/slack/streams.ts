import { and, eq, gt, lt } from 'drizzle-orm';
import { chatEventDedup, chatTurnStreams } from '@kortix/db';
import { db } from '../../shared/db';
import { loadSlackTokenForProject } from '../install-store';
import {
  addReaction,
  appendStream,
  deleteMessage,
  joinChannel,
  postBlocks,
  postMessage,
  removeReaction,
  startStream,
  stopStream,
  updateBlocks,
  type StreamChunk,
  type StreamTaskChunk,
} from '../slack-api';
import { STREAM_TTL_MS, WORKING_EMOJI } from './app';
import type { SlackEvent, TurnStream } from './types';

export function rowToHandle(row: typeof chatTurnStreams.$inferSelect, token: string): TurnStream {
  return {
    channel: row.channel,
    ts: row.messageTs ?? '',
    token,
    triggerTs: row.triggerTs,
    steps: (row.steps as StreamTaskChunk[]) ?? [],
    streaming: row.streaming,
    placeholderActive: row.placeholderActive,
    expiry: new Date(row.expiresAt).getTime(),
    finalized: row.finalized,
    projectId: row.projectId,
    sessionId: row.sessionId,
    teamId: row.teamId,
    originatingEvent: row.originatingEvent as SlackEvent,
  };
}

/** Hydrate a DB row into a usable handle (loads the bot token for its project). */
export async function loadStream(sessionId: string): Promise<TurnStream | null> {
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
export async function saveStream(handle: TurnStream): Promise<void> {
  if (!handle.sessionId) return;
  const values = {
    sessionId: handle.sessionId,
    projectId: handle.projectId,
    teamId: handle.teamId,
    channel: handle.channel,
    triggerTs: handle.triggerTs,
    messageTs: handle.ts || null,
    streaming: handle.streaming,
    placeholderActive: handle.placeholderActive,
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

export async function deleteStream(sessionId: string): Promise<void> {
  if (!sessionId) return;
  await db.delete(chatTurnStreams).where(eq(chatTurnStreams.sessionId, sessionId));
}

/**
 * Atomically claim a stream for finalization so only one replica runs stopStream
 * (the answer relay and the expiry watchdog can race). Returns true to the winner.
 */
export async function claimFinalize(sessionId: string): Promise<boolean> {
  const rows = await db
    .update(chatTurnStreams)
    .set({ finalized: true, updatedAt: new Date() })
    .where(and(eq(chatTurnStreams.sessionId, sessionId), eq(chatTurnStreams.finalized, false)))
    .returning({ sessionId: chatTurnStreams.sessionId });
  return rows.length > 0;
}

// Slack auto-completes a stream after a few minutes without appends and paints
// it as a failure ("Something went wrong" + error badge on the in-progress
// task) even though the agent is fine — it just hasn't hit its next checkpoint
// yet. Heartbeat any live stream quiet for this long to reset Slack's timer.
const HEARTBEAT_AFTER_MS = 3 * 60 * 1000;

// Plan title shown while the turn is still running (heartbeats + dead-stream
// repaints). The finalize pass overwrites it with "Task complete"/"Run failed".
const LIVE_PLAN_TITLE = 'Working on it…';

// Watchdog: finalize streams whose agent died/never sent, keep live streams
// from being auto-failed by Slack's inactivity timeout, and GC expired dedup
// rows. Every replica runs it; claimFinalize / the updated_at heartbeat claim
// make each unit of work single-winner.
setInterval(() => {
  void (async () => {
    try {
      const now = new Date();
      const expired = await db
        .select()
        .from(chatTurnStreams)
        .where(and(eq(chatTurnStreams.finalized, false), lt(chatTurnStreams.expiresAt, now)))
        .limit(50);
      for (const row of expired) {
        // claimFinalize flips the DB row to finalized; build the handle from the
        // row we already read (still finalized=false) so finalizeStream runs once.
        if (!(await claimFinalize(row.sessionId))) continue;
        const token = await loadSlackTokenForProject(row.projectId);
        if (token) {
          await finalizeStream(rowToHandle(row, token), {
            error: '_The run stopped unexpectedly — try again._',
          });
        }
        await deleteStream(row.sessionId);
      }
      await heartbeatLiveStreams(now);
      await db.delete(chatEventDedup).where(lt(chatEventDedup.expiresAt, now));
    } catch (err) {
      console.warn('[slack-webhook] stream watchdog tick failed', err);
    }
  })();
}, 60_000).unref();

// Touch quiet-but-alive streams so Slack doesn't auto-fail them. The UPDATE is
// the cross-replica claim: it only matches rows whose updated_at is still old,
// so concurrent replicas can't double-heartbeat the same row.
async function heartbeatLiveStreams(now: Date): Promise<void> {
  const claimed = await db
    .update(chatTurnStreams)
    .set({ updatedAt: now })
    .where(
      and(
        eq(chatTurnStreams.finalized, false),
        eq(chatTurnStreams.streaming, true),
        gt(chatTurnStreams.expiresAt, now),
        lt(chatTurnStreams.updatedAt, new Date(now.getTime() - HEARTBEAT_AFTER_MS)),
      ),
    )
    .returning();
  for (const row of claimed) {
    const token = await loadSlackTokenForProject(row.projectId);
    if (!token || !row.messageTs) continue;
    const handle = rowToHandle(row, token);
    const r = await appendStream(token, handle.channel, handle.ts, [
      { type: 'plan_update', title: LIVE_PLAN_TITLE },
    ]);
    if (!r.ok) {
      // Slack already killed the stream — flip to dead-stream mode and repaint
      // the message via chat.update so it stops showing Slack's failure state.
      markStreamDead(handle);
      await repaintLivePlan(handle);
      await saveStream(handle);
    }
  }
}

export async function startTurnStream(
  projectId: string,
  teamId: string,
  event: SlackEvent,
  // firstStepTitle was the eager "Spinning up a sandbox" placeholder that
  // appeared in the plan block before the agent did anything. We no longer
  // pre-open the plan stream — the parameter stays for ABI but is ignored.
  _unusedFirstStepTitle?: string,
): Promise<TurnStream | null> {
  if (!event.channel || !event.ts || !event.user) return null;
  const token = await loadSlackTokenForProject(projectId);
  if (!token) return null;
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
    streaming: false,
    placeholderActive: false,
  };
}

// Lazily open a real chat.startStream the moment the agent emits its first
// `slack step`. Deletes the placeholder first so the plan-block message
// appears in its place chronologically.
export async function openStreamWithFirstStep(handle: TurnStream, firstStep: StreamTaskChunk): Promise<boolean> {
  if (handle.streaming) return true;
  if (handle.placeholderActive && handle.ts) {
    await deleteMessage(handle.token, handle.channel, handle.ts);
    handle.placeholderActive = false;
    handle.ts = '';
  }
  const ev = handle.originatingEvent;
  const threadTs = ev.thread_ts ?? ev.ts;
  if (!ev.channel || !ev.user || !threadTs) return false;
  const streamTs = await startStream(
    handle.token,
    ev.channel,
    threadTs,
    ev.user,
    handle.teamId,
    [firstStep],
  );
  if (!streamTs) return false;
  handle.ts = streamTs;
  handle.steps = [firstStep];
  handle.streaming = true;
  return true;
}

// Slack force-completed the stream (inactivity timeout) but the turn is still
// going. Keep the message ts and drop to chat.update mode: streaming=false +
// placeholderActive=false + ts set is the marker relayTurnStep/finalizeStream
// read as "render via repaint, not stream chunks".
export function markStreamDead(handle: TurnStream): void {
  handle.streaming = false;
  handle.placeholderActive = false;
}

export function isDeadStream(handle: TurnStream): boolean {
  return !handle.streaming && !handle.placeholderActive && !!handle.ts && handle.steps.length > 0;
}

// Repaint a dead-stream message with the current plan state via chat.update —
// clears Slack's "Something went wrong" auto-fail rendering and keeps later
// checkpoints visible even though the stream itself can't be appended to.
export async function repaintLivePlan(handle: TurnStream): Promise<void> {
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
export async function finalizeStream(
  handle: TurnStream,
  opts: { answer?: string; error?: string; blocks?: unknown[] },
): Promise<void> {
  if (handle.finalized) return;
  handle.finalized = true;
  const hasContent = Boolean(opts.answer || opts.error || (opts.blocks && opts.blocks.length > 0));
  const body = (opts.answer ?? opts.error ?? '').slice(0, 11000);
  const ev = handle.originatingEvent;
  const threadRoot = ev.thread_ts ?? ev.ts ?? handle.triggerTs;
  if (handle.streaming || isDeadStream(handle)) {
    const last = handle.steps[handle.steps.length - 1];
    const closeLast = !!last && last.status === 'in_progress';
    if (closeLast) last.status = opts.error ? 'error' : 'complete';
    if (handle.streaming) {
      const chunks: StreamChunk[] = [];
      if (closeLast && last) {
        chunks.push({ type: 'task_update', id: last.id, title: last.title, status: last.status });
      }
      if (opts.blocks && opts.blocks.length > 0) {
        chunks.push({ type: 'blocks', blocks: opts.blocks });
      } else if (hasContent) {
        chunks.push({ type: 'markdown_text', text: body });
      }
      await stopStream(handle.token, handle.channel, handle.ts, chunks);
    }
    // Repaint unconditionally — also the recovery path when Slack had already
    // auto-failed the message (stopStream is a no-op there, chat.update isn't).
    await updateBlocks(
      handle.token,
      handle.channel,
      handle.ts,
      planTitleFor(opts),
      buildFinalPlanBlocks(handle, body, opts),
    );
  } else if (hasContent) {
    // No plan was streamed, but there's a reply to deliver. Drop any legacy
    // placeholder first, then post the answer in its place.
    if (handle.placeholderActive && handle.ts) {
      await deleteMessage(handle.token, handle.channel, handle.ts);
      handle.placeholderActive = false;
    }
    if (opts.blocks && opts.blocks.length > 0) {
      await postBlocks(handle.token, handle.channel, body, opts.blocks, threadRoot);
    } else {
      await postMessage(handle.token, handle.channel, body, threadRoot);
    }
  } else if (handle.placeholderActive && handle.ts) {
    // Silent finalize with a legacy placeholder still up → just remove it.
    await deleteMessage(handle.token, handle.channel, handle.ts);
    handle.placeholderActive = false;
  }
  await removeReaction(handle.token, handle.channel, handle.triggerTs, WORKING_EMOJI);
  if (opts.answer && !opts.error) {
    await addReaction(handle.token, handle.channel, handle.triggerTs, 'white_check_mark');
  }
}

function planTitleFor(opts: { answer?: string; error?: string }): string {
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
    if (s.details) {
      task.details = {
        type: 'rich_text',
        elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: s.details }] }],
      };
    }
    if (s.output) {
      task.output = {
        type: 'rich_text',
        elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: s.output }] }],
      };
    }
    if (s.sources && s.sources.length > 0) task.sources = s.sources;
    return task;
  });
}

function buildFinalPlanBlocks(
  handle: TurnStream,
  body: string,
  opts: { answer?: string; error?: string; blocks?: unknown[] },
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
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: body } });
  }
  return blocks;
}
