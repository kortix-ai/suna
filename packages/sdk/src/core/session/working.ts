import type {
  SessionPrompt,
  SessionTurn,
  SessionTurnEnded,
} from '../rest/projects-client/sessions';

/**
 * WHICH observation decided the state.
 *
 * `server` — `GET .../turn`, the control plane's lifecycle authority, or the
 * session's durable prompt inbox. Both are rows the server owns.
 * `stream` — a `session.status` / `session.idle` frame off the live SSE stream.
 * `optimistic` — this tab's own send receipt, which no server source has
 * answered yet.
 *
 * Provenance is part of the answer because the failure this replaces was a
 * projection nobody could attribute: three machines wrote "busy" into one
 * slot — a stall timer, a 30s safety timeout, a status latch — and when the
 * session stayed busy forever, no one could say which of them was lying.
 */
export type WorkingSource = 'server' | 'stream' | 'optimistic';

export interface WorkingProjection {
  state: 'idle' | 'working';
  /** WHICH observation decided this. Never inferred, never fabricated. */
  source: WorkingSource;
  /** The wire message id (server) or the optimistic receipt id. */
  turnId: string | null;
  /** ms epoch at which THIS state began, from the deciding observation. */
  since: number;
  /**
   * The `turn_token` of the turn the control plane is holding open in the
   * freshest read we have, EVEN WHEN something newer outranked it above.
   *
   * `state` is the answer; this is the raw fact behind one of its inputs, and
   * the two are deliberately separable. A caller that must not act while the
   * server still holds authority — a `/` command, which goes straight at
   * OpenCode with no admission gate in front of it — needs to see that
   * authority even in the window where a fresher status frame is (correctly)
   * deciding `idle`. `null` when no fresh read reports one, so a read too old
   * to decide cannot latch it.
   *
   * The TOKEN, never `message_id`. `message_id` is the WIRE id of the prompt
   * that opened the turn, and most producers send none: `postPrompt` omits
   * `messageID` for triggers, Slack/Teams/Telegram, approval-resume and email,
   * and `buildSessionCommandInput` omits it for every `/` command. `GET
   * .../turn` answers `message_id: null` for all of them (the field is
   * `z.string().nullable()`), so an authority check keyed on it read "the
   * server holds nothing" over turns that were streaming. `turn_token` is
   * minted by the control plane for every turn and is never null.
   */
  serverOpenTurnToken: string | null;
}

/**
 * How long an unanswered optimistic receipt may claim `working` on its own.
 *
 * Bounded because a send whose response never arrives must not latch the UI —
 * the failure this whole phase exists to end. Released the moment a server
 * source that CAN know about the send answers; the cap only covers the case
 * where none ever does.
 */
export const OPTIMISTIC_RECEIPT_MAX_MS = 60_000;

/**
 * How long a server observation keeps deciding anything.
 *
 * `useSessionWorking` polls `GET .../turn` every 5s while working and every
 * 15s while idle, and react-query hands back the last SUCCESSFUL read for as
 * long as the ones after it fail. Without this bound, one successful read of an
 * open turn followed by a dev-api 503, an expired JWT, or a closed laptop lid
 * pinned the composer on "working" for the lifetime of the tab — literally the
 * reported bug. Three idle cadences is long enough that an ordinary retry or a
 * backgrounded tab never trips it, and short enough that a dead poll stops
 * being believed.
 */
export const SERVER_OBSERVATION_MAX_MS = 45_000;

/**
 * How long a status frame keeps deciding anything.
 *
 * The stream needs its own bound for the same reason the server read does, and
 * the failure it covers is the SAME one: the SSE stream reaches this tab
 * through the API that serves `/turn`, so when that API drains they stop
 * together. The stream does not go `null` when it stops — the last `busy`
 * frame this tab ever observed stays in the store — so bounding only the
 * server read moved the latch one source over instead of ending it.
 *
 * Equal to the server bound on purpose: while the API answers at all, a fresh
 * `/turn` read decides and this bound is never reached; once it stops
 * answering, both observations are equally blind and neither may stand.
 */
export const STREAM_OBSERVATION_MAX_MS = 45_000;

/**
 * How long ONE reading of the durable inbox keeps deciding.
 *
 * Three cadences of the prompt list's own poll (3s), not of `/turn`'s. A
 * reading says "the server still intends to run N rows", and that claim decays
 * fast: the row it counted may already have been delivered, run, and finished.
 * Held for the server bound instead, a finished prompt left the composer on
 * Stop with its reply on screen for up to 45s.
 */
export const INBOX_OBSERVATION_MAX_MS = 10_000;

/**
 * How long a stop this tab issued may bar a server read from reporting the
 * turn it is ending.
 *
 * Bounded for the same reason the send receipt is, in the other direction: an
 * abort whose acknowledgement never comes must not pin the composer on `idle`
 * over a turn that is genuinely still running. Generous next to the ~1.6s a
 * cancel takes to reach the daemon, and far below the send receipt's cap
 * because the evidence arrives sooner.
 */
export const OPTIMISTIC_ABORT_MAX_MS = 15_000;

/** This tab's own record that a prompt went out. */
export interface SendReceipt {
  /** The submission's tab-local name — never sent anywhere. It exists so a
   *  `working` state can say WHICH send it is standing on. */
  messageId: string;
  /** ms epoch at which the send left this tab. */
  atMs: number;
  /**
   * ms epoch at which the SERVER durably accepted the send (`POST .../prompts`
   * returned, or the REST prompt was acknowledged), or null while the request
   * is still on the wire.
   *
   * This is the instant from which a server read can speak for the send AT ALL.
   * A `/turn` read issued while the POST is still in flight is stamped after
   * the receipt and honestly answers "no turns" — because there is nothing for
   * it to see yet. Believing it swapped the composer's Stop back to Send in the
   * middle of the send and opened the queue drain into the turn about to start.
   */
  acceptedAtMs?: number | null;
}

/**
 * This tab's own record that it asked the running turn to END.
 *
 * The mirror of `SendReceipt`, and it exists for the mirror-image failure. Stop
 * paints the session idle and issues the cancel; the cancel needs a round trip
 * through the control plane and the daemon (~1.6s measured) before the turn
 * authority is actually released. Every `/turn` read issued inside that window
 * still reports the doomed turn — including the one the optimistic idle FRAME
 * itself triggers — so the composer swapped Send back to Stop about 120ms
 * after the click and stayed there for the whole abort.
 */
export interface AbortReceipt {
  /** ms epoch at which the cancel left this tab. */
  atMs: number;
  /**
   * ms epoch at which the server acknowledged the cancel, or null while it is
   * still on the wire.
   *
   * This is the instant from which a server read can see the abort's EFFECT.
   * A read issued before it is honest and out of date, exactly like a `/turn`
   * read issued before `POST .../prompts` returns.
   */
  settledAtMs?: number | null;
}

/** One read of `GET .../turn`, stamped with the instant the read was ISSUED —
 *  not when it landed. An answer is only as fresh as the moment it was asked. */
export interface WorkingServerInput {
  turns: SessionTurn[];
  lastEnded?: SessionTurnEnded;
  atMs: number;
}

/** One observed runtime status frame, stamped when this tab observed it. */
export interface WorkingStreamInput {
  type: 'busy' | 'retry' | 'idle';
  atMs: number;
}

/** One read of the session's durable prompt inbox: how many rows the server is
 *  still going to run, and when that list was read. */
export interface WorkingInboxInput {
  pending: number;
  atMs: number;
}

export interface WorkingInputs {
  optimistic: SendReceipt | null;
  /** This tab's pending stop. `null`/absent means it is not stopping. */
  abort?: AbortReceipt | null;
  /** The durable inbox. `null`/absent means it has never been read here. */
  inbox?: WorkingInboxInput | null;
  server: WorkingServerInput | null;
  stream: WorkingStreamInput | null;
  nowMs: number;
}

/**
 * How many inbox rows are work the server still intends to run.
 *
 * `held` is excluded on purpose: it is the Stop button's own state — the row
 * stays, deliberately not due, until the user sends something or presses "send
 * now". Counting it would leave the composer on Stop with nothing running.
 * `failed` is excluded for the same reason in the other direction: it is over.
 */
export function countLiveInboxPrompts(prompts: readonly SessionPrompt[]): number {
  let live = 0;
  for (const prompt of prompts) {
    if (prompt.state === 'queued' || prompt.state === 'delivering') live += 1;
    else if (prompt.state === 'waiting' && prompt.reason !== 'held') live += 1;
  }
  return live;
}

/** ms epoch, or null for an absent/unparseable instant. */
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
export function projectWorking(inputs: WorkingInputs): WorkingProjection {
  const { optimistic, abort, inbox, server, stream, nowMs } = inputs;
  const receiptLive = !!optimistic && nowMs - optimistic.atMs < OPTIMISTIC_RECEIPT_MAX_MS;
  // TWO floors, because the two server-side observers have different knowledge.
  //
  // `GET .../turn` reads the control plane's ledger, and there is NO row in it
  // until `POST .../prompts` returns. A read issued in that window is stamped
  // after the receipt and still provably cannot see the send, so it may not
  // answer for it at all — hence the infinity while `acceptedAtMs` is null.
  //
  // The SSE stream is the RUNTIME's own voice, and the store stamps a frame
  // when this tab observed it — which only moves when the frame itself changes.
  // So a frame stamped after the send is a NEW transition, not a stale reading,
  // and it is the freshest thing there is. Blocking it too would leave a
  // command's receipt (nothing ever "accepts" a command) claiming `working` for
  // a full minute after its turn had visibly ended.
  const serverFloor = receiptLive
    ? (optimistic!.acceptedAtMs ?? Number.POSITIVE_INFINITY)
    : Number.NEGATIVE_INFINITY;
  const streamFloor = receiptLive ? optimistic!.atMs : Number.NEGATIVE_INFINITY;
  // The stop's floor, built exactly like the send's. A `/turn` read issued
  // before the cancel was ACKNOWLEDGED still reports the turn the cancel is
  // ending, so it may not report `working` from it — the read is honest and
  // out of date. Infinite while the acknowledgement is outstanding, and gone
  // entirely once the receipt ages out, so a cancel nobody answers cannot pin
  // the composer on idle over a turn that is really still running.
  const abortLive = !!abort && nowMs - abort.atMs < OPTIMISTIC_ABORT_MAX_MS;
  const abortFloor = abortLive
    ? (abort!.settledAtMs ?? Number.POSITIVE_INFINITY)
    : Number.NEGATIVE_INFINITY;

  const serverFresh = !!server && nowMs - server.atMs <= SERVER_OBSERVATION_MAX_MS;
  const streamFresh = !!stream && nowMs - stream.atMs <= STREAM_OBSERVATION_MAX_MS;
  const inboxFresh = !!inbox && nowMs - inbox.atMs <= INBOX_OBSERVATION_MAX_MS;

  // The runtime's own end-of-turn frame, while it is fresh enough to decide
  // anything at all. It borrows `STREAM_OBSERVATION_MAX_MS` rather than
  // inventing a second bound: a frame too stale to answer is too stale to veto.
  const idleFrame = streamFresh && stream!.type === 'idle' ? stream! : null;

  /**
   * Whether the runtime has already finished this turn.
   *
   * "Newer read wins" is the rule this replaces, and it is wrong here, because
   * the two observers do not learn the same fact at the same time. The idle
   * frame comes straight off the runtime over SSE. The ledger row is closed by
   * a SEPARATE daemon relay (`POST .../turn-stream` `kind:"end"`) — so a `/turn`
   * read ISSUED after the frame is still ABOUT a turn the frame already ended.
   *
   * MEASURED, local stack 2026-08-21, one ordinary composer turn: the idle
   * frame reached the tab at 00:03:59.964, the refetch that frame itself
   * triggers landed at 00:04:00.150 stamped 44ms later and still reported the
   * turn `active`, and the ledger did not record `ended_at` until 00:04:15.132
   * — the relay for that turn never arrived and a reconciliation sweep closed
   * it 15.1s late. The composer's Stop button and the turn's shimmer came back
   * 186ms after they left and stayed for fifteen seconds, with the finished
   * reply already on screen. Even in the healthy case the relay lands ~200ms
   * after the frame, which is still inside the window its own refetch lands in.
   *
   * `started_at` is what separates the two turns the rule has to tell apart: a
   * turn that began BEFORE the frame is the turn that frame ended, and a turn
   * that began after it is a NEW one the frame knows nothing about — a queued
   * prompt draining, a trigger firing, a second device sending. That one keeps
   * the ledger's full authority, with no delay and no window.
   *
   * A row with no start instant (a legacy `activeTurn`) cannot be ranked
   * against the frame at all, and inventing an order there would hide a live
   * turn. The ledger keeps it.
   */
  const endedByRuntime = (candidate: SessionTurn): boolean => {
    if (!idleFrame) return false;
    const startedAt = instant(candidate.started_at);
    return startedAt !== null && startedAt < idleFrame.atMs;
  };

  const ledgerTurn = serverFresh ? server!.turns[0] : undefined;
  // `serverOpenTurnToken` deliberately keeps reporting the LEDGER's turn even
  // when the runtime's frame has decided the state above — see its docstring.
  // It answers "is the control plane still holding authority", which is what a
  // `/` command must check before going straight at OpenCode with no admission
  // gate in front of it, and that stays true for as long as the row does.
  // Only the WORKING decision moves.
  const serverOpenTurnToken = ledgerTurn?.turn_token ?? null;
  // EVERY row, not just the first. The ledger holds more than one open turn
  // whenever a prompt is forwarded while another is running — measured on the
  // local stack as `turns: [B@00:28:56, A@00:28:22]` — and the list is not
  // ordered newest-first. Testing only `turns[0]` would let one spent row hide
  // a live one behind it, so the projection keeps the first turn the runtime
  // has NOT finished.
  const openTurn = serverFresh ? server!.turns.find((t) => !endedByRuntime(t)) : undefined;

  // A turn the authority is holding open, unless the stream has since said the
  // session went idle. The stream frame is newer BY OBSERVATION, and the daemon
  // relays `turn_end` to the control plane at the same moment the frame is
  // emitted — so a fresher idle frame means this read is simply out of date.
  if (openTurn && server!.atMs >= abortFloor && (!stream || server!.atMs >= stream.atMs)) {
    return {
      state: 'working',
      source: 'server',
      turnId: openTurn.message_id,
      since: instant(openTurn.started_at) ?? server!.atMs,
      serverOpenTurnToken,
    };
  }

  // Durable rows outrank an idle read: the read is right that no TURN is
  // running and wrong that nothing is happening.
  //
  // Every live row counts, INCLUDING the ones already forwarded to the runtime.
  // A prompt queued behind a running turn is handed to OpenCode early and sits
  // in `delivering` ACROSS the turn boundary, so the idle frame that ends the
  // turn in front of it says nothing about it. Measured on the local stack
  // 2026-08-21: suppressing forwarded rows on that frame left the composer idle
  // for 13.8s with the user's queued prompt still waiting to run.
  if (inboxFresh && inbox!.pending > 0) {
    return {
      state: 'working',
      source: 'server',
      turnId: null,
      since: inbox!.atMs,
      serverOpenTurnToken,
    };
  }

  const serverAnswers = serverFresh && !openTurn && server!.atMs >= serverFloor;
  const streamAnswers = streamFresh && stream!.atMs >= streamFloor;

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
      state: 'working',
      source: 'optimistic',
      turnId: optimistic!.messageId,
      since: optimistic!.atMs,
      serverOpenTurnToken,
    };
  }

  // Nothing has answered. Idle is the only honest default: a session is not
  // working because a page failed to ask.
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

/**
 * The next instant at which `projectWorking` could answer differently on its
 * own — i.e. when the OLDEST-lived input ages past its bound.
 *
 * The projection is pure and moves with `nowMs`, which means something has to
 * ask it again at that instant or the bound is never applied. Nothing did: the
 * hook re-renders when react-query hands it new `data`, and a run of failed
 * reads hands back the SAME retained `data` — the observer does not even
 * notify. `SERVER_OBSERVATION_MAX_MS` was therefore evaluated only on renders
 * that happened for some unrelated reason, and in the exact outage it was
 * written for (one success, then a run of 503s) there are none.
 *
 * `null` when nothing is left to expire. Deadlines already in the past are
 * skipped, so re-arming from the timer this returns terminates.
 */
export function workingExpiryAtMs(inputs: WorkingInputs): number | null {
  const { optimistic, abort, inbox, server, stream, nowMs } = inputs;
  const deadlines = [
    optimistic ? optimistic.atMs + OPTIMISTIC_RECEIPT_MAX_MS : null,
    abort ? abort.atMs + OPTIMISTIC_ABORT_MAX_MS : null,
    inbox ? inbox.atMs + INBOX_OBSERVATION_MAX_MS : null,
    server ? server.atMs + SERVER_OBSERVATION_MAX_MS : null,
    stream ? stream.atMs + STREAM_OBSERVATION_MAX_MS : null,
  ];
  let next: number | null = null;
  for (const deadline of deadlines) {
    if (deadline === null || deadline <= nowMs) continue;
    if (next === null || deadline < next) next = deadline;
  }
  return next;
}
