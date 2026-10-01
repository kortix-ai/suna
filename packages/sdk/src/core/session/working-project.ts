import type { SessionTurn } from '../rest/projects-client/sessions';
import type { WorkingInputs, WorkingProjection } from './working';
import { workingEvidence } from './working-evidence';
import { endedByRuntime } from './working-runtime';

function instant(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * The one place a session's working state is decided.
 *
 * Pure, so every rule below is asserted rather than observed by hand. No
 * timers, no latch, no fabricated `SessionStatus` write — a caller that wants
 * to re-evaluate simply calls again with a newer `nowMs`.
 *
 * Precedence:
 *
 *  1. The server is holding a turn open, and no NEWER stream frame contradicts
 *     it → working. `GET .../turn` reads the lifecycle authority rather than the
 *     ledger, so it is the strongest answer there is — but it is still a read
 *     taken at an instant, and an SSE frame from after that instant knows more.
 *  2. The server holds durable inbox rows for this session → working. A prompt
 *     is accepted long before it is a turn: the row has to be drained, the box
 *     may have to resume (18.9s Daytona / 24.5s Platinum, measured), and only
 *     then does `beginSandboxTurn` run. "No turn is running" and "nothing of
 *     yours is in flight" stopped being the same statement when the inbox
 *     landed.
 *  3. The server says no turns, and its read is at least as new as the stream's
 *     last frame → idle. (A dropped end-of-turn frame is exactly why the server
 *     has to be able to outrank a stale stream busy.)
 *  4. The stream's own frame decides.
 *  5. A live optimistic receipt → working.
 *  6. Nothing observed → idle.
 *
 * With TWO cross-cutting freshness rules:
 *
 *  * An observation that could not yet know about a live LOCAL action cannot
 *    answer for it — the send's floors (`SendReceipt.acceptedAtMs`) and the
 *    stop's (`AbortReceipt.settledAtMs`), all built the same way.
 *  * EVERY observation has a maximum age, and past it decides nothing at all in
 *    either direction: `SERVER_OBSERVATION_MAX_MS`, `STREAM_OBSERVATION_MAX_MS`,
 *    `INBOX_OBSERVATION_MAX_MS`. An observation the poll has failed to refresh
 *    for that long is not evidence, and standing on one is the latch. Callers
 *    must re-evaluate at those instants — see `workingExpiryAtMs`.
 */

function runtimeActivity(
  inputs: WorkingInputs,
  evidence: ReturnType<typeof workingEvidence>,
  idleFrame: WorkingInputs['stream'],
  serverOpenTurnToken: string | null,
): WorkingProjection | null {
  const { activity, server } = inputs;
  const { serverFresh, abortFloor, activityFresh } = evidence;
  // Runtime content outranks observer frames only while fresh and after any wire idle.
  const activityAfterIdle = activityFresh && (!idleFrame || activity!.atMs > idleFrame.atMs);
  if (activityAfterIdle && activity!.atMs >= abortFloor) {
    return {
      state: 'working',
      source: 'stream',
      turnId: serverFresh
        ? (server!.turns.find(
            (turn) => turn.state === 'active' && !endedByRuntime(turn, idleFrame, server),
          )?.message_id ?? null)
        : null,
      since: activity!.atMs,
      serverOpenTurnToken,
    };
  }

  return null;
}

function openAuthority(
  inputs: WorkingInputs,
  evidence: ReturnType<typeof workingEvidence>,
  idleFrame: WorkingInputs['stream'],
  serverOpenTurnToken: string | null,
): { result: WorkingProjection | null; openTurn: SessionTurn | undefined } {
  const { server, stream } = inputs;
  const { serverFresh, abortFloor } = evidence;
  // Keep all ledger rows: a spent first row must not hide a live later one.
  const openTurns = serverFresh
    ? server!.turns.filter((t) => !endedByRuntime(t, idleFrame, server))
    : [];
  const openTurn = openTurns.find((turn) => turn.state === 'active') ?? openTurns[0];

  const streamContradicts = !!stream && !(stream.type === 'idle' && stream.origin === 'local');
  if (
    openTurn &&
    server!.atMs >= abortFloor &&
    (!streamContradicts || server!.atMs >= stream!.atMs)
  ) {
    return {
      result: {
        ...(openTurn.state === 'delivering' ? { pendingDelivery: true as const } : {}),
        state: 'working',
        source: 'server',
        turnId: openTurn.message_id,
        since: instant(openTurn.started_at) ?? server!.atMs,
        serverOpenTurnToken,
      },
      openTurn,
    };
  }

  return { result: null, openTurn };
}

function inboxAuthority(
  inputs: WorkingInputs,
  evidence: ReturnType<typeof workingEvidence>,
  serverOpenTurnToken: string | null,
): WorkingProjection | null {
  const { inbox, server, stream } = inputs;
  const {
    inboxFresh,
    abortFloor,
    streamFresh,
    serverFresh,
    receiptLive,
    receiptTurnId,
    abortLive,
  } = evidence;
  if (inboxFresh && inbox!.pending > 0 && inbox!.atMs >= abortFloor) {
    const runtimeIsResponding =
      streamFresh &&
      stream!.type !== 'idle' &&
      (!serverFresh || stream!.atMs > server!.atMs) &&
      stream!.atMs >= abortFloor;
    return {
      ...(!runtimeIsResponding ? { pendingDelivery: true as const } : {}),
      state: 'working',
      source: 'server',
      turnId: receiptLive ? receiptTurnId : null,
      since: inbox!.atMs,
      serverOpenTurnToken,
    };
  }

  // Only a later server read retires a witnessed queue drain; status snapshots cannot.
  const drainedAtMs = inbox?.drainedAtMs;
  const drainFloorHolds =
    inboxFresh &&
    inbox!.pending === 0 &&
    drainedAtMs != null &&
    !abortLive &&
    !(serverFresh && server!.atMs >= drainedAtMs);
  if (drainFloorHolds) {
    return {
      pendingDelivery: true,
      state: 'working',
      source: 'server',
      turnId: null,
      since: drainedAtMs!,
      serverOpenTurnToken,
    };
  }

  return null;
}

function lastAnswer(
  inputs: WorkingInputs,
  evidence: ReturnType<typeof workingEvidence>,
  openTurn: SessionTurn | undefined,
  serverOpenTurnToken: string | null,
): WorkingProjection {
  const { server, stream, optimistic, nowMs } = inputs;
  const {
    serverFresh,
    serverFloor,
    streamFresh,
    streamFloor,
    abortFloor,
    receiptLive,
    receiptTurnId,
  } = evidence;
  // A local send sets separate server and stream floors; abort floors bar old busy reads.
  const serverAnswers = serverFresh && !openTurn && server!.atMs >= serverFloor;
  const streamAnswers =
    streamFresh &&
    stream!.atMs >= streamFloor &&
    (stream!.type === 'idle' || stream!.atMs >= abortFloor);

  if (serverAnswers && (!stream || server!.atMs >= stream.atMs)) {
    return {
      state: 'idle',
      source: 'server',
      turnId: null,
      since: instant(server!.lastEnded?.ended_at) ?? server!.atMs,
      serverOpenTurnToken,
    };
  }

  if (streamAnswers) {
    return {
      state: stream!.type === 'idle' ? 'idle' : 'working',
      source: 'stream',
      turnId: null,
      since: stream!.atMs,
      serverOpenTurnToken,
    };
  }

  if (receiptLive) {
    return {
      pendingDelivery: true,
      state: 'working',
      source: 'optimistic',
      turnId: receiptTurnId,
      since: optimistic!.atMs,
      serverOpenTurnToken,
    };
  }
  const newest =
    server && stream
      ? server.atMs >= stream.atMs
        ? { source: 'server' as const, atMs: server.atMs }
        : { source: 'stream' as const, atMs: stream.atMs }
      : server
        ? { source: 'server' as const, atMs: server.atMs }
        : stream
          ? { source: 'stream' as const, atMs: stream.atMs }
          : { source: 'server' as const, atMs: nowMs };
  return {
    state: 'idle',
    source: newest.source,
    turnId: null,
    since: newest.atMs,
    serverOpenTurnToken,
  };
}

export function decideWorking(inputs: WorkingInputs): WorkingProjection {
  const evidence = workingEvidence(inputs);
  const { server, stream } = inputs;
  const idleFrame = stream && stream.type === 'idle' && stream.origin !== 'local' ? stream : null;
  const serverOpenTurnToken = server?.turns[0]?.turn_token ?? null;
  const activity = runtimeActivity(inputs, evidence, idleFrame, serverOpenTurnToken);
  if (activity) return activity;
  const { result, openTurn } = openAuthority(inputs, evidence, idleFrame, serverOpenTurnToken);
  return (
    result ??
    inboxAuthority(inputs, evidence, serverOpenTurnToken) ??
    lastAnswer(inputs, evidence, openTurn, serverOpenTurnToken)
  );
}
