/**
 * A turn whose opencode process died must be ENDED, not left running forever.
 *
 * A turn ends only when opencode emits `session.idle`/`session.error` over SSE.
 * A killed or crashed opencode emits neither, so the last assistant message
 * stays incomplete and every client streaming it spins — which is what an agent
 * running `kill <opencode pid>` from its own shell produces, and equally what an
 * OOM produces. The lifecycle respawns the box within ~500ms, so the sandbox is
 * fine; only the turn is stranded.
 *
 * Boot already finalized such a turn when it adopted a root. These tests cover
 * the extracted version, which the lifecycle's unplanned-respawn hook now calls
 * too.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { finalizeOrphanedTurn } from '../harness/open-code/boot'
import { TURN_PROBE_WINDOW, inspectOpencodeRoot,
  observeOpencodeDelivery,
  opencodeDeliveryInFlight,
  opencodeTurnInFlight,
} from '../harness/open-code/opencode-turn-state';
import { writeOpenCodeSessionPin } from '../harness/open-code/runtime-state';
import { createHealthRouter } from '../routes/health';
import { createOpenCodeDiagnosticsService, observeRequestedTurn } from '../harness/open-code/diagnostics';

const BASE = 'http://127.0.0.1:4096';
const WORKSPACE = '/workspace';
const SESSION = 'ses_abc';

const ORIGINAL_FETCH = globalThis.fetch;
let calls: string[] = [];
/** Full request URLs, query included. */
let urls: string[] = [];

/** `messages` may be a function: it is called on every message-list read, so a
 *  row can make the second read differ from the first. `onAbort` runs on each
 *  `/abort`, the way real OpenCode stamps `info.error` on the aborted turn. */
function stubFetch(
  messages: unknown | (() => unknown),
  opts: {
    onAbort?: () => void;
    messagesOk?: boolean;
    abortThrows?: boolean;
    sessionStatus?: unknown;
    sessionStatusOk?: boolean;
    messageByIdOk?: boolean;
  } = {},
) {
  calls = []
  urls = []
  ;(globalThis as { fetch: unknown }).fetch = async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url.split('?')[0]}`);
    urls.push(url);
    if (url.includes('/abort')) {
      if (opts.abortThrows) throw new Error('connection refused');
      opts.onAbort?.();
      return new Response('{}', { status: 200 });
    }
    const list = typeof messages === 'function' ? (messages as () => unknown)() : messages;
    if (url.includes('/session/status')) {
      if (opts.sessionStatusOk === false) return new Response('nope', { status: 503 });
      return new Response(JSON.stringify(opts.sessionStatus ?? {}), { status: 200 });
    }
    if (opts.messagesOk === false) return new Response('nope', { status: 503 });
    // `GET /session/:id/message/:messageId` — one message by id, 404
    // `NotFoundError` when the root has no such message (OpenCode 1.18.23).
    const byId = (url.split('?')[0] ?? '').match(/\/message\/([^/]+)$/);
    if (byId) {
      if (opts.messageByIdOk === false) return new Response('nope', { status: 503 });
      const id = decodeURIComponent(byId[1] ?? '');
      const hit = Array.isArray(list)
        ? (list as Array<{ info?: { id?: string } }>).find((m) => m.info?.id === id)
        : undefined;
      if (!hit) {
        return new Response(
          JSON.stringify({ name: 'NotFoundError', data: { message: `Message not found: ${id}` } }),
          { status: 404 },
        );
      }
      return new Response(JSON.stringify(hit), { status: 200 });
    }
    // `GET /session/:id/message?limit=N` — the newest N, chronological.
    const limit = Number(new URL(url).searchParams.get('limit') ?? '');
    const page =
      Array.isArray(list) && Number.isFinite(limit) && limit > 0
        ? (list as unknown[]).slice(-limit)
        : list;
    return new Response(JSON.stringify(page), { status: 200 });
  };
}

// The reload gate asks about the PINNED root, so each test gets its own state
// directory and pins the root it asks about (or pins nothing).
let stateDir: string;
let priorStateDir: string | undefined;
beforeEach(() => {
  priorStateDir = process.env.KORTIX_RUNTIME_STATE_DIR;
  stateDir = mkdtempSync(join(tmpdir(), 'kortix-turn-probe-'));
  process.env.KORTIX_RUNTIME_STATE_DIR = stateDir;
});

afterEach(() => {
  (globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH;
  if (priorStateDir === undefined) delete process.env.KORTIX_RUNTIME_STATE_DIR;
  else process.env.KORTIX_RUNTIME_STATE_DIR = priorStateDir;
  rmSync(stateDir, { recursive: true, force: true });
});

/** `opencodeTurnInFlight` for the given pinned root (`null` = nothing pinned). */
function turnInFlightWithPin(root: string | null): Promise<boolean | null> {
  if (root) writeOpenCodeSessionPin(root);
  return opencodeTurnInFlight(BASE, WORKSPACE);
}

const assistantTurn = (completed?: number) => [
  { info: { role: 'user', time: { completed: 1 } } },
  { info: { role: 'assistant', time: completed === undefined ? {} : { completed } } },
];

describe('finalizeOrphanedTurn', () => {
  test('aborts an assistant turn that never completed', async () => {
    stubFetch(assistantTurn(undefined));

    expect(await finalizeOrphanedTurn(BASE, WORKSPACE, SESSION)).toBe(true);
    expect(calls.filter((c) => c.startsWith('POST') && c.endsWith('/abort'))).toHaveLength(1);
  });

  // Aborting a finished turn would be a visible lie in the transcript, and the
  // lifecycle's hook fires on every unplanned respawn, including ones where
  // nothing was in flight.
  test.each([
    ['a COMPLETED turn', assistantTurn(1_700_000_000)],
    ['a session whose last message is the USER (the prompt never reached the model)', [{ info: { role: 'user', time: { completed: 1 } } }]],
    ['an empty session', []],
  ])('%s is not an orphaned turn', async (_name, transcript) => {
    stubFetch(transcript);

    expect(await finalizeOrphanedTurn(BASE, WORKSPACE, SESSION)).toBe(false);
    expect(calls.some((c) => c.includes('/abort'))).toBe(false);
  });

  test('an unreadable message list does NOT abort', async () => {
    // opencode may still be coming back up after the respawn. Aborting on a
    // failed read would end turns that are perfectly alive.
    stubFetch(null, { messagesOk: false });

    expect(await finalizeOrphanedTurn(BASE, WORKSPACE, SESSION)).toBe(false);
    expect(calls.some((c) => c.includes('/abort'))).toBe(false);
  });

  // A turn still being written reads exactly like an orphaned one on the first
  // look. The settle re-read separates them: an orphan stays unfinished and
  // unchanged. Aborting a live one stamped "Interrupted" under a complete
  // answer (reported from dev).
  test('a turn that finished during the settle window is not aborted', async () => {
    let reads = 0;
    stubFetch(() => (++reads === 1 ? assistantTurn(undefined) : assistantTurn(1_700_000_000)));

    expect(await finalizeOrphanedTurn(BASE, WORKSPACE, SESSION)).toBe(false);
    expect(reads).toBe(2);
    expect(calls.some((c) => c.includes('/abort'))).toBe(false);
  });

  test('a DIFFERENT turn that started during the settle window is not aborted', async () => {
    const first = [
      { info: { id: 'msg_u1', role: 'user', time: { completed: 1 } } },
      { info: { id: 'msg_a1', role: 'assistant', parentID: 'msg_u1', time: {} } },
    ];
    const second = [
      ...first,
      { info: { id: 'msg_u2', role: 'user', time: { completed: 2 } } },
      { info: { id: 'msg_a2', role: 'assistant', parentID: 'msg_u2', time: {} } },
    ];
    let reads = 0;
    stubFetch(() => (++reads === 1 ? first : second));

    expect(await finalizeOrphanedTurn(BASE, WORKSPACE, SESSION)).toBe(false);
    expect(calls.some((c) => c.includes('/abort'))).toBe(false);
  });

  test('is idempotent: a turn a prior finalize already errored is never re-aborted', async () => {
    // Real OpenCode's abort stamps `info.error` and never `time.completed`, so
    // the turn keeps its "incomplete" shape. Every later boot or respawn used
    // to abort it again and re-render "Interrupted".
    let errored = false;
    const transcript = () => [
      { info: { id: 'msg_user', role: 'user', time: { completed: 1 } } },
      {
        info: {
          id: 'msg_assistant',
          role: 'assistant',
          time: {},
          ...(errored ? { error: { name: 'MessageAbortedError', message: 'aborted' } } : {}),
        },
      },
    ];
    stubFetch(transcript, { onAbort: () => (errored = true) });

    expect(await finalizeOrphanedTurn(BASE, WORKSPACE, SESSION)).toBe(true);
    expect(await finalizeOrphanedTurn(BASE, WORKSPACE, SESSION)).toBe(false);
    expect(calls.filter((c) => c.endsWith('/abort'))).toHaveLength(1);
  }, 15_000);

  test('a failing abort is swallowed, never thrown at the lifecycle', async () => {
    // This runs from the respawn path. A daemon that cannot finish bringing
    // opencode back because it could not tidy up a turn is worse than a spinner.
    stubFetch(assistantTurn(undefined), { abortThrows: true });

    expect(await finalizeOrphanedTurn(BASE, WORKSPACE, SESSION)).toBe(true);
  });

  test('the session id and workspace are passed through url-encoded', async () => {
    stubFetch(assistantTurn(undefined));
    await finalizeOrphanedTurn(BASE, '/work space', 'ses/1');

    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(new URL(url).pathname).toContain('/session/ses%2F1/');
      expect(new URL(url).search).toContain('directory=%2Fwork%20space');
    }
  });
});

describe('inspectOpencodeRoot — could-not-tell is its own answer', () => {
  test('a successful read is known', async () => {
    stubFetch(assistantTurn(undefined));
    const result = await inspectOpencodeRoot(BASE, WORKSPACE, SESSION);
    expect(result).toEqual({
      hasMessages: true,
      lastTurnIncomplete: true,
      turnInFlight: true,
      orphanedPrompt: false,
      known: true,
    });
  });

  test('an unreadable list is UNKNOWN, not idle', async () => {
    // Reporting idle here let the reload restart opencode while a turn was
    // running and opencode was merely slow to answer — defeating the one
    // promise the gate makes.
    stubFetch(null, { messagesOk: false });
    const result = await inspectOpencodeRoot(BASE, WORKSPACE, SESSION);
    expect(result.known).toBe(false);
    expect(result.lastTurnIncomplete).toBe(false);
    expect(result.orphanedPrompt).toBe(false);
  });

  test('a TRAILING USER MESSAGE is an ORPHANED PROMPT, not a turn in flight', async () => {
    // THE PHANTOM-BUSY THIS FIELD ENDS. A respawned opencode keeps the
    // persisted user message and loses the in-memory queue, so the root's last
    // message is a prompt nothing will ever answer. Reporting that as
    // `turnInFlight` renewed the control plane's turn grant on every reaper
    // pass — for ever — and the session rendered "working" with nothing
    // working. It is "a prompt was dropped", which the inbox can repair by
    // redelivering it.
    stubFetch([{ info: { role: 'user', time: { completed: 1 } } }]);
    const result = await inspectOpencodeRoot(BASE, WORKSPACE, SESSION);
    expect(result).toEqual({
      hasMessages: true,
      lastTurnIncomplete: false,
      turnInFlight: false,
      orphanedPrompt: true,
      known: true,
    });
  });

  // THE FORWARDED-PROMPT SHAPE. The control plane forwards a prompt INTO a live
  // turn by design, and OpenCode itself appends synthetic `<pty_exited>`
  // wake-ups, so `[user A, assistant A (streaming), user B]` is routine. Read
  // positionally (`msgs[msgs.length - 1]`) it said "no turn running, and a
  // prompt was dropped" — the reload gate would then restart OpenCode straight
  // through a streaming turn. The two facts live on two different rows.
  test('an OPEN assistant still owns runtime when a newer prompt sits after it', async () => {
    stubFetch([
      { info: { id: 'msg_turn_1', role: 'user' } },
      { info: { role: 'assistant', parentID: 'msg_turn_1', time: {} } },
      { info: { id: 'msg_turn_2', role: 'user' } },
    ]);
    expect(await inspectOpencodeRoot(BASE, WORKSPACE, SESSION)).toEqual({
      hasMessages: true,
      lastTurnIncomplete: true,
      turnInFlight: true,
      // Both are true at once: turn 1 is streaming AND turn 2 has no answer.
      orphanedPrompt: true,
      known: true,
    });
  });

  // Attribution is by PARENT LINKAGE, not by "an assistant row exists after
  // this prompt". An assistant parented to the EARLIER prompt does not answer
  // the newer one just because OpenCode created it later.
  test('an assistant parented to an OLDER prompt does not answer the newest one', async () => {
    stubFetch([
      { info: { id: 'msg_turn_1', role: 'user' } },
      { info: { id: 'msg_turn_2', role: 'user' } },
      { info: { role: 'assistant', parentID: 'msg_turn_1', time: { completed: 1234 } } },
    ]);
    const result = await inspectOpencodeRoot(BASE, WORKSPACE, SESSION);
    expect(result.orphanedPrompt).toBe(true);
    expect(result.turnInFlight).toBe(false);
  });

  test('an assistant parented to the newest prompt clears the orphan flag', async () => {
    stubFetch([
      { info: { id: 'msg_turn_1', role: 'user' } },
      { info: { id: 'msg_turn_2', role: 'user' } },
      { info: { role: 'assistant', parentID: 'msg_turn_2', time: { completed: 1234 } } },
    ]);
    expect((await inspectOpencodeRoot(BASE, WORKSPACE, SESSION)).orphanedPrompt).toBe(false);
  });

  test('an EMPTY root has no orphaned prompt', async () => {
    stubFetch([]);
    expect(await inspectOpencodeRoot(BASE, WORKSPACE, SESSION)).toEqual({
      hasMessages: false,
      lastTurnIncomplete: false,
      turnInFlight: false,
      orphanedPrompt: false,
      known: true,
    });
  });
});

describe('opencodeTurnInFlight — the reload gate reads this', () => {
  test('no root is a definite false — nothing has ever run in this sandbox', async () => {
    expect(await turnInFlightWithPin(null)).toBe(false);
  });

  test('a running turn is true', async () => {
    stubFetch(assistantTurn(undefined));
    expect(await turnInFlightWithPin(SESSION)).toBe(true);
  });

  test('a trailing user message is NO LONGER in flight — it is an orphaned prompt', async () => {
    // REWRITTEN, not deleted. This used to assert `true`, on the theory that a
    // queued user message still owns the runtime. It does not: opencode's
    // in-memory queue does not survive a respawn, so the persisted user message
    // outlives every process that could answer it, and reporting it busy is
    // what made a session render "working" for ever. The reload gate now
    // ALLOWS a restart here, which is exactly what unsticks it, and the inbox
    // redelivers the prompt (see `orphanedPrompt`).
    stubFetch([{ info: { role: 'user', time: { completed: 1 } } }]);
    expect(await turnInFlightWithPin(SESSION)).toBe(false);
  });

  test('an unreadable box is NULL, so the gate refuses instead of restarting', async () => {
    // The bug this closes: returning false here handed the reload a green light
    // while a turn was running and opencode was merely slow to answer.
    stubFetch(null, { messagesOk: false });
    expect(await turnInFlightWithPin(SESSION)).toBeNull();
  });

  // ASK, DON'T INFER. The step boundary inside ONE turn — latest step completed,
  // tools running, next step's message not created yet — is invisible in the
  // transcript and plain to `/session/status`. The gate must not restart here.
  test.each(['busy', 'retry'])('a %s root is in flight even when the transcript reads finished', async (type) => {
    stubFetch(assistantTurn(1_700_000_000), { sessionStatus: { [SESSION]: { type } } });
    expect(await turnInFlightWithPin(SESSION)).toBe(true);
    expect(calls.some((url) => url.includes('/session/status'))).toBe(true);
  });

  // The oracle CANNOT clear a husk: an assistant message left open by a writer
  // that died reads idle to `/session/status` (its process is gone) and in
  // flight in the transcript. The post-respawn cleanup exists for that husk, so
  // the transcript keeps its one-directional vote.
  test('an idle root does NOT clear an open assistant message left by a dead writer', async () => {
    stubFetch(assistantTurn(undefined), { sessionStatus: { [SESSION]: { type: 'idle' } } });
    expect(await turnInFlightWithPin(SESSION)).toBe(true);
  });
});

describe('opencodeDeliveryInFlight — lifecycle acceptance recovery', () => {
  const user1 = { info: { id: 'msg_turn_1', role: 'user' } };
  const user2 = { info: { id: 'msg_turn_2', role: 'user' } };
  const open1 = { info: { id: 'msg_step_1', role: 'assistant', parentID: 'msg_turn_1', time: {} } };
  const completed1 = { info: { role: 'assistant', parentID: 'msg_turn_1', time: { completed: 1234 } } };

  // While the root itself reports busy (or retrying), no transcript shape may
  // end the turn. 2026-08-20 (a customer session): prompts forwarded INTO a
  // live turn and OpenCode's synthetic `<pty_exited>` wake-ups put a NEWER user
  // message on the root while the SAME loop still streamed the older turn. The
  // old "a newer user message owns the root" rule read that as terminal and
  // destroyed live turn authority at 12:48:51Z; the step completed 12:48:54Z.
  test.each([
    ['a delivered user message without an assistant', [user1], 'busy'],
    ['a delivered user message while retrying', [user1], 'retry'],
    ['an incomplete assistant for the exact message', [user1, open1], 'busy'],
    ['an unanswered older turn under a later user message', [user1, user2], 'busy'],
    ['a streaming step under a later wake-up message', [user1, open1, user2], 'busy'],
  ])('%s is active while the root reports %s', async (_name, transcript, type) => {
    stubFetch(transcript, { sessionStatus: { [SESSION]: { type } } });
    expect(await opencodeDeliveryInFlight(BASE, WORKSPACE, SESSION, 'msg_turn_1')).toBe(true);
    expect(calls.some((url) => url.includes('/session/status'))).toBe(true);
  });

  // An unreadable status is UNKNOWN, never a licence to end a turn.
  test.each([
    ['a user-only message', [user1]],
    ['an older turn under a later user message', [user1, user2]],
    ['a completed latest step (possibly between steps)', [user1, completed1]],
    ['a streaming step under a later wake-up message', [user1, open1, user2]],
  ])('%s with an unreadable status is unknown', async (_name, transcript) => {
    stubFetch(transcript, { sessionStatusOk: false });
    expect(await opencodeDeliveryInFlight(BASE, WORKSPACE, SESSION, 'msg_turn_1')).toBeNull();
  });

  test('a user-only message in an idle OpenCode session is terminal', async () => {
    stubFetch([user1], { sessionStatus: { [SESSION]: { type: 'idle' } } });
    expect(await opencodeDeliveryInFlight(BASE, WORKSPACE, SESSION, 'msg_turn_1')).toBe(false);
  });

  test('an absent OpenCode session status is terminal', async () => {
    stubFetch([user1], { sessionStatus: {} });
    expect(await opencodeDeliveryInFlight(BASE, WORKSPACE, SESSION, 'msg_turn_1')).toBe(false);
  });

  test('an unrecognized OpenCode session status makes user-only evidence unknown', async () => {
    stubFetch([user1], { sessionStatus: { [SESSION]: { type: 'paused' } } });
    expect(await opencodeDeliveryInFlight(BASE, WORKSPACE, SESSION, 'msg_turn_1')).toBeNull();
  });

  test.each([
    ['an unanswered older turn under a later user message', [user1, user2]],
    ['a streaming step under a later wake-up message', [user1, open1, user2]],
  ])('%s ends once the root is idle', async (_name, transcript) => {
    stubFetch(transcript, { sessionStatus: { [SESSION]: { type: 'idle' } } });
    expect(await opencodeDeliveryInFlight(BASE, WORKSPACE, SESSION, 'msg_turn_1')).toBe(false);
  });

  // The two live-turn shapes STACKED: a wake-up user row landing in the
  // step-boundary window, where the latest step of the SAME turn reads
  // completed while its tools run. There is no `completed` exception to the
  // busy rule.
  test('a later user message after a COMPLETED answer stays active while the root is busy', async () => {
    stubFetch([user1, completed1, user2], { sessionStatus: { [SESSION]: { type: 'busy' } } });
    const observed = await observeOpencodeDelivery(BASE, WORKSPACE, SESSION, 'msg_turn_1');
    expect(observed).toEqual({ inFlight: true, end: null });
    expect(calls.some((url) => url.includes('/session/status'))).toBe(true);
  });

  // Each step of ONE turn is its own assistant message, completed at the
  // step's end; the next step's message does not exist yet while tools run.
  test('a completed latest step with a busy root stays active (step boundary)', async () => {
    stubFetch([user1, completed1], { sessionStatus: { [SESSION]: { type: 'busy' } } });
    expect(await opencodeDeliveryInFlight(BASE, WORKSPACE, SESSION, 'msg_turn_1')).toBe(true);
  });

  test('a non-retryable error is terminal even while the root reports busy', async () => {
    // A terminally-errored answer cannot un-fail; a busy root there is a NEWER
    // turn already running. Holding this record open would pin authority on a
    // turn that is provably over.
    stubFetch(
      [
        user1,
        {
          info: {
            role: 'assistant',
            parentID: 'msg_turn_1',
            time: {},
            error: { name: 'APIError', data: { isRetryable: false } },
          },
        },
      ],
      { sessionStatus: { [SESSION]: { type: 'busy' } } },
    );
    expect(await opencodeDeliveryInFlight(BASE, WORKSPACE, SESSION, 'msg_turn_1')).toBe(false);
  });

  test('a terminal assistant error without a completion timestamp does not hold the reload gate', async () => {
    stubFetch([
      user1,
      {
        info: {
          role: 'assistant',
          parentID: 'msg_turn_1',
          time: {},
          error: { name: 'APIError', data: { isRetryable: false } },
        },
      },
    ]);
    expect(await turnInFlightWithPin(SESSION)).toBe(false);
  });

  test('a retryable assistant error remains active during backoff', async () => {
    stubFetch([
      user1,
      {
        info: {
          role: 'assistant',
          parentID: 'msg_turn_1',
          time: {},
          error: { name: 'APIError', data: { isRetryable: true } },
        },
      },
    ], { sessionStatus: { [SESSION]: { type: 'retry' } } });
    expect(await opencodeDeliveryInFlight(BASE, WORKSPACE, SESSION, 'msg_turn_1')).toBe(true);
    expect(await turnInFlightWithPin(SESSION)).toBe(true);
  });
});

/**
 * `turn_in_flight: false` is FOUR different outcomes, and the control plane
 * writes exactly one of them into `kortix.session_turns.end_reason`. Only this
 * daemon can tell them apart — it is the process holding the message list — so
 * it names the outcome and the API stops guessing 'completed' for every one.
 */
describe('observeOpencodeDelivery — WHY the turn is not in flight', () => {
  test("a client-minted message that never reached OpenCode is 'abandoned'", async () => {
    // The user's prompt vanished. Recording this as 'completed' is the exact
    // mislabel that makes end_reason unable to name a lost delivery.
    stubFetch([{ info: { id: 'msg_other', role: 'user' } }]);
    expect(await observeOpencodeDelivery(BASE, WORKSPACE, SESSION, 'msg_turn_1')).toEqual({
      inFlight: false,
      end: 'abandoned',
    });
  });

  test("a terminal model error is 'failed', the same word the session.error relay writes", async () => {
    stubFetch([
      { info: { id: 'msg_turn_1', role: 'user' } },
      {
        info: {
          role: 'assistant',
          parentID: 'msg_turn_1',
          time: {},
          error: { name: 'APIError', data: { isRetryable: false } },
        },
      },
    ]);
    expect(await observeOpencodeDelivery(BASE, WORKSPACE, SESSION, 'msg_turn_1')).toEqual({
      inFlight: false,
      end: 'failed',
    });
  });

  test("a completed assistant is 'completed'", async () => {
    stubFetch([
      { info: { id: 'msg_turn_1', role: 'user' } },
      { info: { role: 'assistant', parentID: 'msg_turn_1', time: { completed: 1234 } } },
    ]);
    expect(await observeOpencodeDelivery(BASE, WORKSPACE, SESSION, 'msg_turn_1')).toEqual({
      inFlight: false,
      end: 'completed',
    });
  });

  test("an assistant message left open on an idle root is 'failed'", async () => {
    // The husk a killed model call leaves. Through the relay this same end
    // arrives as session.error and is written 'failed'; observing it late must
    // not rename it.
    stubFetch(
      [
        { info: { id: 'msg_turn_1', role: 'user' } },
        { info: { role: 'assistant', parentID: 'msg_turn_1', time: {} } },
      ],
      { sessionStatus: { [SESSION]: { type: 'idle' } } },
    );
    expect(await observeOpencodeDelivery(BASE, WORKSPACE, SESSION, 'msg_turn_1')).toEqual({
      inFlight: false,
      end: 'failed',
      // An assistant message exists, so the prompt WAS answered — badly, but
      // answered. Redelivering it would run the user's message twice.
      orphanedPrompt: false,
    });
  });

  test('a delivered prompt that produced nothing on an idle root names no outcome', async () => {
    // The message landed, so it was not abandoned, and no assistant message
    // says how it ended. An honest null beats an invented reason — but the
    // prompt IS orphaned, which is a separate, provable fact.
    stubFetch([{ info: { id: 'msg_turn_1', role: 'user' } }], {
      sessionStatus: { [SESSION]: { type: 'idle' } },
    });
    expect(await observeOpencodeDelivery(BASE, WORKSPACE, SESSION, 'msg_turn_1')).toEqual({
      inFlight: false,
      end: null,
      orphanedPrompt: true,
    });
  });

  test('a newer turn on the root ends this one with the reason its own messages carry', async () => {
    stubFetch(
      [
        { info: { id: 'msg_turn_1', role: 'user' } },
        { info: { role: 'assistant', parentID: 'msg_turn_1', time: { completed: 7 } } },
        { info: { id: 'msg_turn_2', role: 'user' } },
      ],
      { sessionStatus: { [SESSION]: { type: 'idle' } } },
    );
    expect(await observeOpencodeDelivery(BASE, WORKSPACE, SESSION, 'msg_turn_1')).toEqual({
      inFlight: false,
      end: 'completed',
    });
    // AMENDED: the status IS consulted first. "A busy root next to a newer user
    // row must be the newer turn" is not provable from the transcript — the
    // step-boundary window makes a LIVE turn look exactly like this — so the
    // idle status is what licenses the terminal verdict here, and the reason
    // still comes from turn 1's own messages.
    expect(calls.some((url) => url.includes('/session/status'))).toBe(true);
  });

  test('a running turn and an unreadable box name no outcome', async () => {
    stubFetch(
      [
        { info: { id: 'msg_turn_1', role: 'user' } },
        { info: { role: 'assistant', parentID: 'msg_turn_1', time: {} } },
      ],
      { sessionStatus: { [SESSION]: { type: 'busy' } } },
    );
    expect(await observeOpencodeDelivery(BASE, WORKSPACE, SESSION, 'msg_turn_1')).toEqual({
      inFlight: true,
      end: null,
    });

    stubFetch(null, { messagesOk: false });
    expect(await observeOpencodeDelivery(BASE, WORKSPACE, SESSION, 'msg_turn_1')).toEqual({
      inFlight: null,
      end: null,
    });
  });
});

/** The real `/kortix/health` router over the OpenCode diagnostics service. */
function healthRouter() {
  return createHealthRouter(
    {
      cfg: { projectTarget: '/workspace', autoClone: false, sandboxToken: '' } as never,
      bootTime: Date.now(),
      bootState: { repoMaterializationError: null, timeline: [] },
      staticWebPort: null,
      resources: () => null,
    },
    createOpenCodeDiagnosticsService({
      getState: () => 'ok',
      getInternalUrl: () => BASE,
      getPid: () => 1,
      getActivePort: () => 4096,
    } as never),
  );
}

describe('turn observation (diagnostics.observeRequestedTurn, /kortix/health?turn=1)', () => {
  test('a message-scoped request carries the outcome the messages prove', async () => {
    stubFetch([
      { info: { id: 'msg_turn_1', role: 'user' } },
      { info: { role: 'assistant', parentID: 'msg_turn_1', time: { completed: 1234 } } },
    ]);
    expect(
      await observeRequestedTurn(BASE, WORKSPACE, { sessionId: SESSION, messageId: 'msg_turn_1' }),
    ).toEqual({ inFlight: false, end: 'completed' });
  });

  test('a root-scoped request cannot attribute an outcome to one turn', async () => {
    // Without a message id the answer is about the whole root, so naming an
    // end reason would attribute another turn's outcome to this one.
    stubFetch(assistantTurn(1_700_000_000));
    expect(
      await observeRequestedTurn(BASE, WORKSPACE, { sessionId: SESSION, messageId: null }),
    ).toEqual({ inFlight: false, end: null, orphanedPrompt: false });
  });

  test('a root-scoped request DOES name `abandoned` for an orphaned prompt', async () => {
    // The one ending a root-scoped read can prove: the root's last message is
    // a user prompt nothing answered. That is not another turn's outcome, it is
    // this root's own state, and it routes straight into the inbox's redelivery
    // (`DAEMON_REPORTABLE_END_REASONS` already accepts `abandoned`).
    stubFetch([{ info: { role: 'user', time: { completed: 1 } } }]);
    expect(
      await observeRequestedTurn(BASE, WORKSPACE, { sessionId: SESSION, messageId: null }),
    ).toEqual({ inFlight: false, end: 'abandoned', orphanedPrompt: true });
  });

  // `abandoned` routes straight into the inbox's redelivery, so it may never be
  // said about a prompt that is executing. Between "the prompt is persisted"
  // and "its assistant message exists" a LIVE delivery looks exactly like an
  // orphan; only `/session/status` can tell them apart.
  test('a root-scoped request does NOT call a live delivery abandoned', async () => {
    stubFetch([{ info: { id: 'msg_turn_1', role: 'user', time: { completed: 1 } } }], {
      sessionStatus: { [SESSION]: { type: 'busy' } },
    });
    expect(
      await observeRequestedTurn(BASE, WORKSPACE, { sessionId: SESSION, messageId: null }),
    ).toEqual({ inFlight: true, end: null, orphanedPrompt: true });
  });

  test('a root-scoped request with an unreadable status stays unknown, never abandoned', async () => {
    stubFetch([{ info: { id: 'msg_turn_1', role: 'user', time: { completed: 1 } } }], {
      sessionStatusOk: false,
    });
    expect(
      await observeRequestedTurn(BASE, WORKSPACE, { sessionId: SESSION, messageId: null }),
    ).toEqual({ inFlight: null, end: null });
  });

  test('an unreadable root-scoped request stays unknown', async () => {
    stubFetch(null, { messagesOk: false });
    expect(
      await observeRequestedTurn(BASE, WORKSPACE, { sessionId: SESSION, messageId: null }),
    ).toEqual({ inFlight: null, end: null });
  });

  test('/kortix/health?turn=1 puts the outcome on the wire as turn_end', async () => {
    // The cross-process contract: the control plane writes this value straight
    // into session_turns.end_reason and cannot derive it, because only this
    // process holds the message list.
    stubFetch([
      { info: { id: 'msg_turn_1', role: 'user' } },
      {
        info: {
          role: 'assistant',
          parentID: 'msg_turn_1',
          time: {},
          error: { name: 'APIError', data: { isRetryable: false } },
        },
      },
    ]);
    const router = healthRouter();

    const body = (await (
      await router.request(`/?turn=1&turn_session_id=${SESSION}&turn_message_id=msg_turn_1`)
    ).json()) as Record<string, unknown>;

    expect(body.turn_in_flight).toBe(false);
    expect(body.turn_end).toBe('failed');
    expect(body.turn_orphaned_prompt).toBe(false);
  });

  test('/kortix/health?turn=1 reports a root-scoped orphaned prompt on the wire', async () => {
    stubFetch([{ info: { role: 'user', time: { completed: 1 } } }]);
    const router = healthRouter();

    const body = (await (
      await router.request(`/?turn=1&turn_session_id=${SESSION}`)
    ).json()) as Record<string, unknown>;

    // `turn_in_flight: false` + `turn_end: 'abandoned'` is what the reaper reads
    // as terminal-and-abandoned, which is the input its redelivery needs.
    expect(body.turn_in_flight).toBe(false);
    expect(body.turn_end).toBe('abandoned');
    expect(body.turn_orphaned_prompt).toBe(true);
  });

  test('turn observation falls back to the pinned root when no session is requested', async () => {
    // An ambiguous prompt-delivery timeout knows only the message it sent; the
    // pinned root is the session that message went to.
    writeOpenCodeSessionPin(SESSION);
    stubFetch([
      { info: { id: 'msg_turn_1', role: 'user' } },
      { info: { role: 'assistant', parentID: 'msg_turn_1', time: { completed: 1234 } } },
    ]);

    const body = (await (
      await healthRouter().request('/?turn=1&turn_message_id=msg_turn_1')
    ).json()) as Record<string, unknown>;

    expect(body.turn_in_flight).toBe(false);
    expect(body.turn_end).toBe('completed');
    expect(urls.some((url) => new URL(url).pathname === `/session/${SESSION}/message`)).toBe(true);
  });

  test('/kortix/health without ?turn=1 still answers nothing about turns', async () => {
    stubFetch(assistantTurn(undefined));
    const router = healthRouter();

    const body = (await (await router.request('/')).json()) as Record<string, unknown>;

    // Health is polled every few seconds on every idle box; the turn read costs
    // a call into opencode and stays opt-in.
    expect('turn_in_flight' in body).toBe(false);
    expect('turn_end' in body).toBe(false);
  });
});

describe('turn probes read a bounded window, never the whole root', () => {
  // 2026-08-25, SampleCo: one root's full message list was 276.7 MB (inline
  // base64 image parts). Parsing it never fit the probe budget, the daemon
  // answered `turn_in_flight: null` on every reaper visit for 2.5 hours after
  // the turn had finished, and the session showed "working" until the ledger
  // was settled by hand. `?limit=` keeps the read proportional to the
  // question; a prompt older than the window is proved by fetching it by id.
  const stepsAfter = (prompt: string, n: number, last: Record<string, unknown>) => [
    { info: { id: prompt, role: 'user' } },
    ...Array.from({ length: n - 1 }, (_, i) => ({
      info: { id: `msg_step_${i}`, role: 'assistant', parentID: prompt, time: { completed: 1 + i } },
    })),
    { info: { id: 'msg_step_last', role: 'assistant', parentID: prompt, ...last } },
  ];

  test('the list request carries limit=TURN_PROBE_WINDOW', async () => {
    stubFetch([{ info: { id: 'msg_turn_1', role: 'user' } }]);
    const raw: string[] = [];
    const stubbed = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = async (input: unknown, init?: unknown) => {
      raw.push(String(input));
      return (stubbed as (i: unknown, n?: unknown) => Promise<Response>)(input, init);
    };
    await observeOpencodeDelivery(BASE, WORKSPACE, SESSION, 'msg_turn_1');
    await inspectOpencodeRoot(BASE, WORKSPACE, SESSION);
    const lists = raw.filter((u) => /\/message\?/.test(u));
    expect(lists.length).toBe(2);
    for (const u of lists) {
      expect(new URL(u).searchParams.get('limit')).toBe(String(TURN_PROBE_WINDOW));
    }
  });

  test("a prompt older than the window is proved by id and its newest step names 'completed'", async () => {
    // 20 step messages after the prompt: the prompt is outside a 12-message
    // window. Every message IN the window is after it, so the window alone
    // answers the "how did it end" question; the by-id read only proves the
    // prompt reached this root.
    stubFetch(stepsAfter('msg_turn_1', 20, { time: { completed: 99 } }), {
      sessionStatus: { [SESSION]: { type: 'idle' } },
    });
    expect(await observeOpencodeDelivery(BASE, WORKSPACE, SESSION, 'msg_turn_1')).toEqual({
      inFlight: false,
      end: 'completed',
    });
    expect(calls).toContain(`GET ${BASE}/session/${SESSION}/message/msg_turn_1`);
  });

  test('a prompt missing from the window AND from the root is abandoned, nothing else is', async () => {
    stubFetch(stepsAfter('msg_other', 20, { time: { completed: 99 } }), {
      sessionStatus: { [SESSION]: { type: 'idle' } },
    });
    expect(await observeOpencodeDelivery(BASE, WORKSPACE, SESSION, 'msg_turn_1')).toEqual({
      inFlight: false,
      end: 'abandoned',
    });
  });

  test('a prompt missing from the window stays unreadable when the by-id read fails', async () => {
    // A 503 on the by-id read is "could not tell", not "never arrived":
    // calling it abandoned would redeliver a prompt that may be mid-turn.
    stubFetch(stepsAfter('msg_turn_1', 20, { time: {} }), { messageByIdOk: false });
    expect(await observeOpencodeDelivery(BASE, WORKSPACE, SESSION, 'msg_turn_1')).toEqual({
      inFlight: null,
      end: null,
    });
  });

  test('inspectOpencodeRoot: a window of step messages after an older prompt is answered, not orphaned', async () => {
    stubFetch(stepsAfter('msg_turn_1', 20, { time: {} }));
    const inspection = await inspectOpencodeRoot(BASE, WORKSPACE, SESSION);
    expect(inspection.known).toBe(true);
    expect(inspection.hasMessages).toBe(true);
    expect(inspection.orphanedPrompt).toBe(false);
    expect(inspection.lastTurnIncomplete).toBe(true);
  });
});
