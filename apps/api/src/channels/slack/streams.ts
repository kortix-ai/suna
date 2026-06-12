import { and, eq, lt } from 'drizzle-orm';
import { chatEventDedup, chatTurnStreams } from '@kortix/db';
import { db } from '../../shared/db';
import { loadSlackTokenForProject } from '../install-store';
import {
  addReaction,
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

// Watchdog: finalize streams whose agent died/never sent, and GC expired dedup
// rows. Every replica runs it; claimFinalize makes the work single-winner.
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
      await db.delete(chatEventDedup).where(lt(chatEventDedup.expiresAt, now));
    } catch (err) {
      console.warn('[slack-webhook] stream watchdog tick failed', err);
    }
  })();
}, 60_000).unref();

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
  if (handle.streaming) {
    const chunks: StreamChunk[] = [];
    const last = handle.steps[handle.steps.length - 1];
    if (last && last.status === 'in_progress') {
      last.status = opts.error ? 'error' : 'complete';
      chunks.push({
        type: 'task_update',
        id: last.id,
        title: last.title,
        status: last.status,
      });
    }
    if (opts.blocks && opts.blocks.length > 0) {
      chunks.push({ type: 'blocks', blocks: opts.blocks });
    } else if (hasContent) {
      chunks.push({ type: 'markdown_text', text: body });
    }
    await stopStream(handle.token, handle.channel, handle.ts, chunks);
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

function buildFinalPlanBlocks(
  handle: TurnStream,
  body: string,
  opts: { answer?: string; error?: string; blocks?: unknown[] },
): unknown[] {
  const tasks = handle.steps.map((s) => {
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

  const blocks: Array<Record<string, unknown>> = [
    {
      type: 'plan',
      title: planTitleFor(opts),
      tasks,
    },
  ];
  if (opts.blocks && opts.blocks.length > 0) {
    for (const b of opts.blocks) blocks.push(b as Record<string, unknown>);
  } else if (body) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: body } });
  }
  return blocks;
}
