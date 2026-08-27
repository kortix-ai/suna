/**
 * GET /v1/projects/:projectId/sessions/:sessionId/stream
 *
 * ONE client connection for everything that MOVES in a session.
 *
 * Before this route a live session cost the browser a permanent SSE connection
 * THROUGH the sandbox proxy to OpenCode's `/global/event`, plus a 2 s
 * `/permission` poll, plus a 2 s `/question` poll, plus a 30 s transcript
 * tail-verify, plus a 30 s `/kortix/health` probe, plus `/turn` and `/prompts`
 * on their own timers. Seven clocks, six of them polling, and none of them able
 * to tell "nothing happened" from "I lost the connection".
 *
 * This route multiplexes all of it onto one stream with two cursors.
 *
 * ─── TWO CHANNELS, TWO ID-SPACES, NEVER RENUMBERED ─────────────────────────
 * WS-Z1's rule is load-bearing and is obeyed literally:
 *
 *   channel: 'runtime'  — the daemon's own envelopes, FORWARDED VERBATIM. The
 *     daemon assigned `seq`; this route adds `channel` and `epoch` and changes
 *     nothing else. It does not reorder, does not renumber, does not drop, and
 *     does not decide what a client missed — `?since=`/`?epoch=` are passed
 *     straight through to the daemon, which owns replay and `kortix.resync`.
 *
 *   channel: 'control'  — the API's own snapshots, carrying `cseq` + `cepoch`
 *     in a SEPARATE id-space. A client that mixed the two cursors would resume
 *     at a number that means nothing on the other side, which is exactly the
 *     failure the separation exists to make impossible.
 *
 * The SSE `id:` field carries BOTH cursors as `epoch|seq|cepoch|cseq`, so a
 * `Last-Event-ID` reconnect (the only thing `EventSource` sends on its own)
 * restores the same position an explicit `?since=&epoch=&since_control=&cepoch=`
 * would. Blank segments mean "no position on that channel yet".
 *
 * ─── THE STREAM NEVER ERRORS BECAUSE THE BOX IS ABSENT ─────────────────────
 * A stopped, booting, unreachable or never-provisioned sandbox produces
 * `kortix.runtime.status {state:'down'}` and NOTHING ELSE changes: the control
 * channel keeps delivering the queue, the turn verdict and the wake progress,
 * which is precisely the state a user watching a waking box needs to see. The
 * response is 200 from the first byte in every one of those cases.
 *
 * ─── THIS ROUTE NEVER WAKES A BOX ──────────────────────────────────────────
 * It attaches only when the sandbox row ALREADY says `active`. Waking is
 * `POST .../start`'s job and only its job; a read that could start a sandbox
 * would resurrect reaper-stopped boxes and bill for them, which is a real
 * incident in this repo's register, not a hypothetical.
 */

import { createRoute, z } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { sessionSandboxes } from '@kortix/db';

import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors } from '../../openapi';
import { db } from '../../shared/db';
import {
  assertProjectCapability,
  loadProjectForUser,
  loadVisibleSession,
  sessionIsTombstoned,
} from '../lib/access';
import { projectsApp } from '../lib/app';
import { callerKortixSessionId } from '../lib/caller-session';
import { UUID_V4_REGEX } from '../lib/serializers';
import {
  CONTROL_EPOCH,
  subscribeControlEvents,
  type ControlEvent,
} from '../lib/session-control-events';
import {
  acquireControlReconciler,
  publishRuntimeStateFrame,
} from '../lib/session-control-reconciler';
import { refreshRuntimeProjection } from '../lib/session-runtime-projection-refresh';
import { readRuntimeLeg } from '../lib/session-runtime-projection';
import {
  openRuntimeEventStream,
  parseSseFrames,
} from '../lib/session-runtime-transport';

/** Our own keepalive cadence. Matches the daemon's, so a stream with no box
 *  attached still proves liveness on the same clock a healthy one does. */
export const STREAM_HEARTBEAT_MS = 15_000;

/** Backoff ladder for re-attaching to the daemon, in ms. Capped, never zero. */
export const RUNTIME_ATTACH_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000];

/** How long to wait before re-checking a sandbox that is not `active`. */
export const RUNTIME_IDLE_RECHECK_MS = 5_000;

/** Frames the daemon may send that mean the projection changed underneath us. */
const PROJECTION_INVALIDATING_EVENTS = new Set([
  'server.instance.disposed',
  'mcp.tools.changed',
  'plugin.added',
  'kortix.resync',
]);

interface StreamCursor {
  epoch: string | null;
  seq: number | null;
}

/** `epoch|seq|cepoch|cseq`, with blanks for "no position on that channel". */
export function encodeStreamId(runtime: StreamCursor, cepoch: string, cseq: number | null): string {
  return [
    runtime.epoch ?? '',
    runtime.seq === null ? '' : String(runtime.seq),
    cepoch,
    cseq === null ? '' : String(cseq),
  ].join('|');
}

export interface DecodedStreamId {
  epoch: string | null;
  seq: number | null;
  cepoch: string | null;
  cseq: number | null;
}

/** Inverse of {@link encodeStreamId}. Anything malformed decodes to "no position". */
export function decodeStreamId(value: string | null | undefined): DecodedStreamId {
  const empty: DecodedStreamId = { epoch: null, seq: null, cepoch: null, cseq: null };
  if (!value) return empty;
  const parts = value.split('|');
  if (parts.length !== 4) return empty;
  const [epoch, seq, cepoch, cseq] = parts;
  return {
    epoch: epoch ? epoch : null,
    seq: seq && /^\d+$/.test(seq) ? Number(seq) : null,
    cepoch: cepoch ? cepoch : null,
    cseq: cseq && /^\d+$/.test(cseq) ? Number(cseq) : null,
  };
}

function parseCursorQuery(c: {
  req: { query: (name: string) => string | undefined; header: (name: string) => string | undefined };
}): DecodedStreamId {
  const fromHeader = decodeStreamId(c.req.header('last-event-id'));
  const since = c.req.query('since');
  const cseq = c.req.query('since_control');
  return {
    // An explicit query parameter always beats the header: the SDK sends what
    // it actually applied, and the browser sends whatever it last received.
    epoch: c.req.query('epoch')?.trim() || fromHeader.epoch,
    seq: since && /^\d+$/.test(since) ? Number(since) : fromHeader.seq,
    cepoch: c.req.query('cepoch')?.trim() || fromHeader.cepoch,
    cseq: cseq && /^\d+$/.test(cseq) ? Number(cseq) : fromHeader.cseq,
  };
}

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/sessions/{sessionId}/events',
    tags: ['sessions'],
    summary: 'GET /:projectId/sessions/:sessionId/events',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
      query: z.object({
        since: z.string().optional(),
        epoch: z.string().optional(),
        since_control: z.string().optional(),
        cepoch: z.string().optional(),
      }),
    },
    responses: {
      200: {
        description:
          'A never-ending text/event-stream multiplexing the sandbox runtime channel ' +
          '(daemon seq/epoch, forwarded verbatim) and the control channel (cseq/cepoch).',
        content: { 'text/event-stream': { schema: z.any() } },
      },
      ...errors(400, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    // The SAME gate `open-bundle` applies, for the same reason: this stream
    // carries strictly the facts that route already serves, so it must not be
    // reachable by anyone who could not have asked for them one at a time.
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_SESSION_READ,
    );
    const visible = await loadVisibleSession(
      loaded,
      sessionId,
      callerKortixSessionId(c),
      callerKortixSessionId(c),
    );
    if (!visible) return c.json({ error: 'Not found' }, 404);
    if (sessionIsTombstoned(visible.row)) return c.json({ error: 'Not found' }, 404);

    const cursor = parseCursorQuery(c);
    const userId = String(c.get('userId') ?? loaded.userId ?? '');
    const accountId = String(loaded.row.accountId);

    const abort = new AbortController();
    const runtime: StreamCursor = { epoch: cursor.epoch, seq: cursor.seq };

    const encoder = new TextEncoder();
    let closed = false;
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

    const writeRaw = (payload: string): void => {
      if (closed || !controllerRef) return;
      try {
        controllerRef.enqueue(encoder.encode(payload));
      } catch {
        closed = true;
        abort.abort();
      }
    };

    /** A frame that advances neither cursor (status, hello, our heartbeat). */
    const writeMeta = (event: string, data: Record<string, unknown>): void => {
      writeRaw(`event: ${event}\ndata: ${JSON.stringify({ ...data, channel: 'stream' })}\n\n`);
    };

    const writeControl = (event: ControlEvent): void => {
      writeRaw(
        `event: ${event.type}\nid: ${encodeStreamId(runtime, CONTROL_EPOCH, event.cseq)}\n` +
          `data: ${JSON.stringify(event)}\n\n`,
      );
    };

    // A client resuming inside THIS process's control epoch has already applied
    // everything up to its cursor. Seeding the write watermark from it is what
    // stops the open-snapshot from re-sending four frames the client already
    // holds — measured on the live stack: a reconnect at cseq=4 re-delivered
    // cseq 1..4 before this. A resync clears it below, because a client that
    // could not be replayed exactly must get the whole picture again.
    let lastControlCseq: number | null =
      cursor.cepoch === CONTROL_EPOCH && typeof cursor.cseq === 'number' ? cursor.cseq : null;
    const writeControlOnce = (event: ControlEvent): void => {
      if (lastControlCseq !== null && event.cseq <= lastControlCseq) return;
      lastControlCseq = event.cseq;
      writeControl(event);
    };

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller;

        const reconciler = acquireControlReconciler(sessionId);
        let heartbeat: ReturnType<typeof setInterval> | null = null;

        // Replay + live listener in the SAME synchronous tick — the handoff
        // property WS-Z1's bus documents. Nothing can be published between
        // reading the ring and registering, so nothing is lost or duplicated.
        let replaying = true;
        const queued: ControlEvent[] = [];
        const subscription = subscribeControlEvents(
          sessionId,
          { sinceCseq: cursor.cseq, cepoch: cursor.cepoch },
          (event) => {
            if (replaying) queued.push(event);
            else writeControlOnce(event);
          },
        );

        writeMeta('kortix.stream.hello', {
          type: 'kortix.stream.hello',
          session_id: sessionId,
          project_id: projectId,
          at: Date.now(),
          control: {
            cepoch: CONTROL_EPOCH,
            head_cseq: subscription.headCseq,
            since: cursor.cseq,
          },
          runtime: {
            attached: false,
            requested_since: cursor.seq,
            requested_epoch: cursor.epoch,
          },
        });

        if (subscription.resync) {
          // Never silent. The client is told the gap could not be replayed and
          // is then handed a complete snapshot of every subsystem — which is
          // possible only because a control frame is a snapshot, not a delta.
          writeRaw(
            `event: kortix.control.resync\ndata: ${JSON.stringify(subscription.resync)}\n\n`,
          );
          // The client's cursor is void. Everything below is written again.
          lastControlCseq = null;
        }
        for (const event of subscription.replay) writeControlOnce(event);

        void (async () => {
          // The current snapshot of every subsystem, taken once the reconciler
          // has read them at least once. A client therefore never has to wait a
          // reconcile interval to learn the queue it already knows how to draw.
          await reconciler.ready();
          if (closed) return;
          for (const event of reconciler.snapshot()) writeControlOnce(event);
          replaying = false;
          for (const event of queued) writeControlOnce(event);
          queued.length = 0;
        })();

        // Our own TYPED heartbeat — not a `:` comment. An SSE parser swallows
        // comments without yielding anything, so a comment keeps TCP warm while
        // leaving every liveness watchdog blind (the 2026-08-26 prod defect).
        heartbeat = setInterval(() => {
          writeMeta('kortix.stream.heartbeat', {
            type: 'kortix.stream.heartbeat',
            at: Date.now(),
            runtime_seq: runtime.seq,
            control_cseq: lastControlCseq,
          });
        }, STREAM_HEARTBEAT_MS);
        (heartbeat as unknown as { unref?: () => void }).unref?.();

        void pumpRuntime({
          sessionId,
          projectId,
          accountId,
          userId,
          runtime,
          abort,
          isClosed: () => closed,
          controlCseq: () => lastControlCseq,
          writeMeta,
          writeRaw,
        });

        abort.signal.addEventListener('abort', () => {
          if (heartbeat) clearInterval(heartbeat);
          heartbeat = null;
          subscription.unsubscribe();
          reconciler.release();
          replaying = false;
          if (!closed) {
            closed = true;
            try {
              controller.close();
            } catch {
              // Already closed by the client hanging up.
            }
          }
        });
      },
      cancel() {
        closed = true;
        abort.abort();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        // `no-transform` matters as much as `no-cache`: an intermediary that
        // "helpfully" compresses or buffers an event stream breaks it.
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Kortix-Control-Epoch': CONTROL_EPOCH,
      },
    }) as any;
  },
);

interface PumpArgs {
  sessionId: string;
  projectId: string;
  accountId: string;
  userId: string;
  runtime: StreamCursor;
  abort: AbortController;
  isClosed: () => boolean;
  /** The control cursor this connection has written, so a runtime frame's
   *  `id:` still restores BOTH channels on a `Last-Event-ID` reconnect. */
  controlCseq: () => number | null;
  writeMeta: (event: string, data: Record<string, unknown>) => void;
  writeRaw: (payload: string) => void;
}

/**
 * Attach to the daemon's event stream, forward it, and re-attach forever.
 *
 * Every exit from the inner loop emits `kortix.runtime.status {state:'down'}`
 * with a reason before it sleeps, so the client can always tell "the box went
 * away" from "the API stopped talking to me" — the distinction the old
 * proxied SSE could not make and self-healed by polling.
 */
async function pumpRuntime(args: PumpArgs): Promise<void> {
  let attempt = 0;
  let announcedDownReason: string | null = null;

  const announceDown = (reason: string): void => {
    // Repeat only when the reason CHANGES. A box that has been stopped for an
    // hour must not produce an event every five seconds.
    if (announcedDownReason === reason) return;
    announcedDownReason = reason;
    args.writeMeta('kortix.runtime.status', {
      type: 'kortix.runtime.status',
      state: 'down',
      reason,
      at: Date.now(),
    });
  };

  while (!args.isClosed() && !args.abort.signal.aborted) {
    let sandbox: { externalId: string | null; status: string } | undefined;
    try {
      [sandbox] = await db
        .select({ externalId: sessionSandboxes.externalId, status: sessionSandboxes.status })
        .from(sessionSandboxes)
        .where(eq(sessionSandboxes.sessionId, args.sessionId))
        .limit(1);
    } catch {
      // A DB blip must not end the stream. Say so and re-check on the ladder.
      announceDown('control_plane_unavailable');
      await sleep(RUNTIME_IDLE_RECHECK_MS, args.abort.signal);
      continue;
    }

    // NEVER wake. Only `active` is attached to; anything else waits and
    // re-checks, and the control channel is already telling the client why.
    if (!sandbox?.externalId || sandbox.status !== 'active') {
      announceDown(sandbox ? `sandbox_${sandbox.status}` : 'no_sandbox');
      await sleep(RUNTIME_IDLE_RECHECK_MS, args.abort.signal);
      continue;
    }

    const opened = await openRuntimeEventStream(
      { externalId: sandbox.externalId, userId: args.userId },
      { since: args.runtime.seq, epoch: args.runtime.epoch, signal: args.abort.signal },
    );
    if (!opened.ok) {
      announceDown(opened.reason);
      const delay =
        RUNTIME_ATTACH_BACKOFF_MS[Math.min(attempt, RUNTIME_ATTACH_BACKOFF_MS.length - 1)]!;
      attempt += 1;
      await sleep(delay, args.abort.signal);
      continue;
    }

    attempt = 0;
    announcedDownReason = null;
    if (opened.epoch) args.runtime.epoch = opened.epoch;
    args.writeMeta('kortix.runtime.status', {
      type: 'kortix.runtime.status',
      state: 'up',
      epoch: args.runtime.epoch,
      since: args.runtime.seq,
      at: Date.now(),
    });

    // We are already talking to this box: take the projection while the
    // connection is warm. Awaited only inside this detached pump, never on a
    // request's response path.
    void refreshProjection(args, 'attach');

    try {
      for await (const frame of parseSseFrames(opened.body)) {
        if (args.isClosed() || args.abort.signal.aborted) break;
        forwardRuntimeFrame(args, frame.event, frame.data);
      }
      announceDown('stream_ended');
    } catch (error) {
      announceDown(
        error instanceof Error && error.message ? error.message.slice(0, 200) : 'stream_error',
      );
    }
    await sleep(RUNTIME_ATTACH_BACKOFF_MS[0]!, args.abort.signal);
  }
}

/**
 * Forward ONE daemon frame.
 *
 * The envelope is written back out with exactly two additions — `channel` and
 * `epoch` — and no other change. `seq` is the daemon's number and stays the
 * daemon's number; `payload` is OpenCode's `properties` verbatim, which is what
 * lets an existing SDK reducer apply it unchanged.
 */
function forwardRuntimeFrame(args: PumpArgs, event: string | null, data: string): void {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(data) as Record<string, unknown>;
  } catch {
    // A frame we cannot parse is still a frame the daemon sent. Pass the bytes
    // through under a name that says what happened rather than dropping them.
    args.writeRaw(`event: ${event ?? 'message'}\ndata: ${data}\n\n`);
    return;
  }

  const type = typeof parsed.type === 'string' ? parsed.type : (event ?? 'message');
  const seq = typeof parsed.seq === 'number' ? parsed.seq : null;

  if (type === 'kortix.hello') {
    const epoch = typeof parsed.epoch === 'string' ? parsed.epoch : null;
    if (epoch && epoch !== args.runtime.epoch) {
      // A new daemon boot invalidates our seq. Adopt the epoch and forget the
      // cursor; the daemon has already decided what to replay.
      args.runtime.seq = null;
    }
    args.runtime.epoch = epoch ?? args.runtime.epoch;
  }

  if (type === 'kortix.resync') {
    // The daemon could not replay the gap. Its own frame carries the recovery
    // instructions, so it is forwarded UNCHANGED and the cursor is dropped.
    args.runtime.seq = null;
  }

  if (PROJECTION_INVALIDATING_EVENTS.has(type)) {
    void refreshProjection(args, type);
  }

  if (seq !== null) args.runtime.seq = seq;

  const envelope = { ...parsed, channel: 'runtime', epoch: args.runtime.epoch };
  const id =
    seq === null ? null : encodeStreamId(args.runtime, CONTROL_EPOCH, args.controlCseq());
  args.writeRaw(
    `event: ${type}\n${id ? `id: ${id}\n` : ''}data: ${JSON.stringify(envelope)}\n\n`,
  );
}

/**
 * Read the projection off the box and publish it on the control channel.
 *
 * This is what makes a FIRST open fast even before the daemon push exists: the
 * stream attaches at the same moment the bundle is read, so the roster the
 * bundle could not serve from Postgres arrives seconds later on the stream —
 * through the same channel, with the same cursor, applied by the same reducer.
 */
async function refreshProjection(args: PumpArgs, trigger: string): Promise<void> {
  try {
    const outcome = await refreshRuntimeProjection(
      {
        sessionId: args.sessionId,
        projectId: args.projectId,
        accountId: args.accountId,
        userId: args.userId,
      },
      { force: trigger !== 'attach' },
    );
    if (!outcome.refreshed) return;
    const leg = await readRuntimeLeg(args.sessionId);
    if (args.isClosed()) return;
    publishRuntimeStateFrame(args.sessionId, leg);
  } catch {
    // A projection refresh is an optimisation. It never degrades the stream.
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
