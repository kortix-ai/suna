import { and, eq, lt } from 'drizzle-orm';
import { chatEventDedup, chatTurnStreams } from '@kortix/db';
import { db } from '../../shared/db';
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

/** Hydrate a DB row into a usable handle (loads the bot token for its project). */
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
        if (!(await claimFinalize(row.sessionId))) continue;
        const token = await loadSlackTokenForProject(row.projectId);
        if (token) {
          await finalizeTurn(rowToHandle(row, token), { error: '_This run ended without a reply._' });
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
  opts: { answer?: string; error?: string; blocks?: unknown[] },
): Promise<void> {
  if (handle.finalized) return;
  handle.finalized = true;
  const hasContent = Boolean(opts.answer || opts.error || (opts.blocks && opts.blocks.length > 0));
  const body = (opts.answer ?? opts.error ?? '').slice(0, 11000);
  const ev = handle.originatingEvent;
  const threadRoot = ev.thread_ts ?? ev.ts ?? handle.triggerTs;

  if (handle.ts && handle.steps.length > 0) {
    // A plan message exists — close out the last in-progress step and render the
    // final plan (+ answer/error) into it via chat.update.
    const last = handle.steps[handle.steps.length - 1];
    if (last && last.status === 'in_progress') last.status = opts.error ? 'error' : 'complete';
    await updateBlocks(
      handle.token,
      handle.channel,
      handle.ts,
      planTitleFor(opts),
      buildFinalPlanBlocks(handle, body, opts),
    );
  } else if (hasContent) {
    // The agent posted no `slack step` (no plan message) but has a reply — post
    // it fresh in-thread.
    if (opts.blocks && opts.blocks.length > 0) {
      await postBlocks(handle.token, handle.channel, body, opts.blocks, threadRoot);
    } else {
      await postMessage(handle.token, handle.channel, body, threadRoot);
    }
  }
  // A silent finalize with no plan message and no content leaves the thread
  // untouched — we just clear the ⏳ below.
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
  handle: LiveTurn,
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
