// What the drain puts ON THE WIRE for an inbox prompt.
//
// Three claims, each of which has a way of failing silently:
//
//  1. A prompt whose only content is an attachment (no text at all) is a legal
//     send — the composer allows it and the POST route accepts it — so the
//     drain must deliver it instead of dead-lettering it as "missing text".
//  2. A prompt that WAITED behind a live turn must be re-minted before it goes
//     out. The client minted its id when the user pressed Enter; by the time
//     admission lets it through, the running turn has written messages with
//     HIGHER ids, and OpenCode reads a lower id as already answered — the turn
//     silently never runs.
//  3. A redelivery must prove the prompt is still unanswered. A `delivering`
//     record is only evidence that the ACCEPTANCE write failed; if the
//     transcript shows an assistant reply under that message, the turn ran and
//     re-sending it would run the user's message a second time.
//
// Same mocking caveat as the sibling engine.ts test files: `mock.module` is
// process-global in bun:test, so this file must run on its own (the repo's
// `--isolate` test runner already guarantees that).
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { projectSessions, projects, sessionLifecycleCommands, sessionSandboxes } from '@kortix/db';
import type { SessionLifecycleCommandRow } from '../store';
import { mintWireMessageId, wireIdTime } from '../../wire-message-id';

const SESSION_ID = 'sess-inbox-delivery-1';
const ACCOUNT_ID = 'acct-1';
const PROJECT_ID = 'proj-1';
const EXTERNAL_ID = 'sandbox-1';
const OC_SESSION_ID = 'oc-1';

// Anchored to the REAL clock: the re-mint corrects against the transcript only
// within `MAX_WIRE_ID_CLOCK_CORRECTION` (1h), so ids fabricated at a fixed
// wall-clock date would fall outside that window and stop exercising the lift.
const NOW_MS = Date.now();
/** Minted ~10 minutes ago: the id the client sent when the user pressed Enter. */
const SUBMITTED_WIRE_ID = mintWireMessageId({
  nowMs: NOW_MS - 10 * 60_000,
  random: () => 0.5,
}).id;
/** A message the running turn wrote AFTER that — the id the re-mint must beat. */
const NEWER_TRANSCRIPT_ID = mintWireMessageId({ nowMs: NOW_MS - 60_000, random: () => 0.5 }).id;
/**
 * An id the way OPENCODE mints one: a raw `Date.now()` scaled into the id
 * clock, with no backdate. That is what makes it younger than
 * `WIRE_ID_BACKDATE_MS` and so the case where the mint is LIFTED above the
 * transcript rather than merely clocked past it.
 */
const OPENCODE_MINTED_ID = `msg_${(((BigInt(NOW_MS - 40_000) * BigInt(0x1000)) & BigInt(0xffffffffffff)).toString(16).padStart(12, '0'))}AbCdEfGhIjKlMn`;

let requeues: Array<{ commandId: string; reason: string; availableAt: Date }> = [];
let sessionRow: Record<string, unknown> | null = null;
/** The session's one box, as the turn-authority read sees it. Null = no box. */
let boxRow: { status: string; metadata: Record<string, unknown> | null } | null = null;
/** The newest id the inbox's OWN rows say this session has already delivered,
 *  as `readDeliveredWireIdFloor` reads it back. Null = nothing delivered yet. */
let deliveredFloor: bigint | null = null;
let transcript: Array<Record<string, unknown>> = [];
let capturedBodies: Array<Record<string, unknown>> = [];
let succeededCalls: Array<{ commandId: string; result: unknown }> = [];
// A delivered row that carries a wire id no longer closes — it stays OPEN as
// `forwarded` until the session_turns ledger confirms a turn consumed that id.
let forwardedCalls: Array<{ commandId: string; sessionId: string; wireMessageId: string }> = [];
let failedCalls: Array<{ commandId: string; message: string }> = [];
let payloadPatches: Array<Record<string, unknown>> = [];
let claimed: SessionLifecycleCommandRow[] = [];
let openDelayBySession: Record<string, Promise<void> | undefined> = {};
let events: string[] = [];

mock.module('../../../config', () => ({
  config: { KORTIX_URL: 'https://api.test' },
  SANDBOX_VERSION: 'test',
}));

mock.module('../../../shared/db', () => ({
  hasDatabase: () => true,
  db: {
    select: (projection?: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === projectSessions) return sessionRow ? [sessionRow] : [];
            if (table === projects) return [{ projectId: PROJECT_ID, accountId: ACCOUNT_ID }];
            if (table === sessionSandboxes) return boxRow ? [boxRow] : [];
            // The aggregate `readDeliveredWireIdFloor` runs: always one row,
            // with a null when the session has never delivered anything.
            // Keyed on the PROJECTION, not the table: the admission gate reads
            // the same table for a different question, and answering it with a
            // floor row would make every send look like it lost the order race.
            if (table === sessionLifecycleCommands && projection && 'newest' in projection) {
              return [{ newest: deliveredFloor === null ? null : deliveredFloor.toString() }];
            }
            return [];
          },
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        payloadPatches.push(values);
        return { where: async () => {} };
      },
    }),
  }, auditDb: {
    select: (projection?: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === projectSessions) return sessionRow ? [sessionRow] : [];
            if (table === projects) return [{ projectId: PROJECT_ID, accountId: ACCOUNT_ID }];
            if (table === sessionSandboxes) return boxRow ? [boxRow] : [];
            // The aggregate `readDeliveredWireIdFloor` runs: always one row,
            // with a null when the session has never delivered anything.
            // Keyed on the PROJECTION, not the table: the admission gate reads
            // the same table for a different question, and answering it with a
            // floor row would make every send look like it lost the order race.
            if (table === sessionLifecycleCommands && projection && 'newest' in projection) {
              return [{ newest: deliveredFloor === null ? null : deliveredFloor.toString() }];
            }
            return [];
          },
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        payloadPatches.push(values);
        return { where: async () => {} };
      },
    }),
  },
}));

mock.module('../../session-title-generate', () => ({
  generateSessionTitleFromFirstPrompt: async () => {},
}));

mock.module('../../routes/shared', () => ({
  openSession: async (input: { sessionId: string }) => {
    events.push(`open:${input.sessionId}`);
    const delay = openDelayBySession[input.sessionId];
    if (delay) await delay;
    return {
      stage: 'ready',
      sandbox: { external_id: EXTERNAL_ID, provider: 'daytona' },
      opencode_session_id: OC_SESSION_ID,
    };
  },
}));

mock.module('../../../sandbox-proxy/routes/preview', () => ({
  forwardToSandbox: async (
    _externalId: string,
    _port: number,
    _access: unknown,
    _method: string,
    _path: string,
    _query: string,
    _headers: Headers,
    body: ArrayBuffer,
  ) => {
    capturedBodies.push(JSON.parse(new TextDecoder().decode(body)));
    return new Response(null, { status: 204 });
  },
}));

mock.module('../../lib/sessions', () => ({
  createProjectSession: async () => {
    throw new Error('not expected');
  },
}));
mock.module('../actor', () => ({
  resolveProjectAutomationActor: async () => 'automation-user-1',
  resolveAgentRunAttribution: async () => null,
}));
mock.module('../backpressure', () => ({
  sessionBackpressureState: async () => ({ shouldQueue: false, reason: null }),
}));
mock.module('../store', () => ({
  promoteNextInboxRow: async () => null,
  requeueForAdmission: async (commandId: string, reason: string, availableAt: Date) => {
    requeues.push({ commandId, reason, availableAt });
  },
  claimCreateSessionCommand: async () => {
    throw new Error('not expected');
  },
  claimDueLifecycleCommands: async () => claimed,
  enqueueContinueSessionCommand: async () => {
    throw new Error('not expected');
  },
  markCommandFailed: async (commandId: string, message: string) => {
    failedCalls.push({ commandId, message });
  },
  markCommandQueued: async () => {
    throw new Error('not expected');
  },
  markCommandForwarded: async (commandId: string, sessionId: string, wireMessageId: string) => {
    forwardedCalls.push({ commandId, sessionId, wireMessageId });
  },
  markCommandSucceeded: async (commandId: string, result: unknown) => {
    succeededCalls.push({ commandId, result });
  },
  // `inbox-rows.ts` imports this at module load, so the mock has to carry it or
  // the engine import fails outright. Nothing in this file drives a row through
  // it, so an identity pass-through is the whole of it.
  withNextDeliveryAttempt: (payload: unknown) => payload,
  resultFromExistingCommand: () => {
    throw new Error('not expected');
  },
}));

mock.module('../../opencode-mapping', () => ({
  sandboxOpencodeEndpoint: async () => ({ url: 'https://sandbox.test', headers: {} }),
}));

const { drainSessionLifecycleQueue, executeQueuedContinue } = await import('../engine');

/** Every `redeliveredMessageId` the drain persisted, read out of the jsonb
 *  merge parameter the UPDATE bound. */
function persistedWireIds(): string[] {
  const found: string[] = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    for (const value of Object.values(node as Record<string, unknown>)) {
      if (typeof value === 'string' && value.includes('redeliveredMessageId')) {
        const parsed = JSON.parse(value) as { redeliveredMessageId?: string };
        if (parsed.redeliveredMessageId) found.push(parsed.redeliveredMessageId);
      } else walk(value);
    }
  };
  for (const patch of payloadPatches) walk(patch);
  return found;
}

function baseRow(overrides: Partial<SessionLifecycleCommandRow> = {}): SessionLifecycleCommandRow {
  const now = new Date(NOW_MS);
  return {
    commandId: 'cmd-1',
    commandType: 'continue_session',
    source: 'ui',
    status: 'running',
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    accountId: ACCOUNT_ID,
    actorUserId: null,
    idempotencyKey: null,
    payload: {
      text: 'say hi',
      clientMessageId: 'q_1',
      wireMessageId: SUBMITTED_WIRE_ID,
      parts: [{ type: 'text', text: 'say hi' }],
    },
    result: {},
    attempts: 0,
    availableAt: now,
    lockedBy: null,
    lockedUntil: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as SessionLifecycleCommandRow;
}

beforeEach(() => {
  sessionRow = {
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    status: 'running',
    metadata: {},
    sandboxProvider: 'daytona',
    baseRef: 'main',
    agentName: 'agent',
    opencodeSessionId: OC_SESSION_ID,
    sandboxUrl: `https://sandbox.test/p/${EXTERNAL_ID}/8000/`,
  };
  boxRow = null;
  deliveredFloor = null;
  transcript = [];
  capturedBodies = [];
  succeededCalls = [];
  forwardedCalls = [];
  failedCalls = [];
  payloadPatches = [];
  claimed = [];
  openDelayBySession = {};
  events = [];
  globalThis.fetch = (async (url: string | URL) => {
    const href = String(url);
    // The staged-revert guard reads the session row; the re-mint and the
    // answered check read the message list.
    if (href.includes('/message')) {
      return new Response(JSON.stringify(transcript), { status: 200 });
    }
    return new Response(JSON.stringify({ id: OC_SESSION_ID }), { status: 200 });
  }) as typeof fetch;
});

describe('executeQueuedContinue — what actually goes on the wire', () => {
  test('an ATTACHMENT-ONLY prompt is delivered, not dead-lettered', async () => {
    // The POST route deliberately accepts an empty flattened text when a
    // non-text part carries the content. A drain that requires text turns that
    // 202 into a permanently dead row — and dead-lettering a continue_session
    // also parks the session.
    const outcome = await executeQueuedContinue(
      baseRow({
        payload: {
          text: '',
          clientMessageId: 'q_file',
          wireMessageId: SUBMITTED_WIRE_ID,
          parts: [
            { type: 'text', text: '' },
            { type: 'file', mime: 'image/png', url: 'https://files.test/a.png', filename: 'a.png' },
          ],
        },
      }),
    );

    expect(outcome).toBe('succeeded');
    expect(failedCalls).toEqual([]);
    expect(capturedBodies).toHaveLength(1);
    expect((capturedBodies[0].parts as unknown[])[1]).toMatchObject({ type: 'file' });
  });

  test('a prompt that WAITED is re-minted above the transcript before it is sent', async () => {
    // The running turn wrote messages while this prompt sat in the inbox. The
    // id the client minted at submit time now sorts BELOW them, and OpenCode
    // reads that as already answered — the turn would never run.
    transcript = [
      { info: { id: SUBMITTED_WIRE_ID, role: 'user' } },
      { info: { id: NEWER_TRANSCRIPT_ID, role: 'assistant', parentID: 'msg_other' } },
    ];

    const outcome = await executeQueuedContinue(
      baseRow({ result: { admission_reason: 'older_prompt_pending' } }),
    );

    expect(outcome).toBe('succeeded');
    expect(capturedBodies).toHaveLength(1);
    const sent = capturedBodies[0].messageID as string;
    expect(sent).not.toBe(SUBMITTED_WIRE_ID);
    expect(wireIdTime(sent)!).toBeGreaterThan(wireIdTime(NEWER_TRANSCRIPT_ID)!);
    // Persisted BEFORE the POST, so a crash between mint and delivery reuses
    // one id instead of minting a second.
    expect(persistedWireIds()).toEqual([sent]);
  });

  test('a PROMOTED prompt ("send now") is re-minted, not sent under the stale id', async () => {
    // `retryInboxPrompt` clears `result` wholesale — that is what makes the row
    // stop reading `waiting` — so `admission_reason` cannot be the input to the
    // re-mint decision. The marker that survives lives in the PAYLOAD, which is
    // merged rather than replaced. Without this, "send now" on a prompt that
    // queued behind a live turn delivers the id minted when the user pressed
    // Enter, and OpenCode reads it as already answered.
    transcript = [
      { info: { id: SUBMITTED_WIRE_ID, role: 'user' } },
      { info: { id: NEWER_TRANSCRIPT_ID, role: 'assistant', parentID: 'msg_other' } },
    ];

    const outcome = await executeQueuedContinue(
      baseRow({
        payload: { ...baseRow().payload, remintOnDelivery: true },
        result: { promoted: true },
      }),
    );

    expect(outcome).toBe('succeeded');
    const sent = capturedBodies[0].messageID as string;
    expect(wireIdTime(sent)!).toBeGreaterThan(wireIdTime(NEWER_TRANSCRIPT_ID)!);
  });

  test('a re-mint whose transcript read FAILED still sorts above OpenCode’s own clock', async () => {
    // The fallback used to mint `now - WIRE_ID_BACKDATE_MS` (2 min). OpenCode
    // mints from a raw `Date.now()`, with no backdate, so every message it
    // wrote in the last two minutes sorted ABOVE the re-mint — the exact silent
    // drop the re-mint exists to prevent, on the one path (an unreadable box)
    // that is also the commonest trigger for a redelivery.
    globalThis.fetch = (async (url: string | URL) => {
      const href = String(url);
      if (href.includes('/message')) return new Response('nope', { status: 502 });
      return new Response(JSON.stringify({ id: OC_SESSION_ID }), { status: 200 });
    }) as typeof fetch;

    const outcome = await executeQueuedContinue(
      baseRow({ result: { admission_reason: 'older_prompt_pending' } }),
    );

    expect(outcome).toBe('succeeded');
    const sent = capturedBodies[0].messageID as string;
    // An id OpenCode minted 60s ago, the way OpenCode mints one: a raw
    // `Date.now()` scaled into the id clock, with no backdate.
    const openCodeId =
      (BigInt(NOW_MS - 60_000) * BigInt(0x1000)) & BigInt(0xffffffffffff);
    expect(wireIdTime(sent)!).toBeGreaterThan(openCodeId);
  });

  test('a PROMPT ALREADY ANSWERED is never re-sent, redelivery or not', async () => {
    // The already-answered guard is not a redelivery-only concern: every
    // re-mint path re-reads the transcript, and the same assistant reply proves
    // the same thing on all of them.
    transcript = [
      { info: { id: SUBMITTED_WIRE_ID, role: 'user' } },
      {
        info: {
          id: NEWER_TRANSCRIPT_ID,
          role: 'assistant',
          parentID: SUBMITTED_WIRE_ID,
          time: { completed: NOW_MS - 30_000 },
        },
      },
    ];

    const outcome = await executeQueuedContinue(
      baseRow({
        payload: { ...baseRow().payload, remintOnDelivery: true },
        result: { promoted: true },
      }),
    );

    expect(outcome).toBe('succeeded');
    expect(capturedBodies).toEqual([]);
    expect(succeededCalls).toEqual([
      { commandId: 'cmd-1', result: { status: 'skipped', reason: 'already_answered' } },
    ]);
  });

  test('a prompt that never waited keeps the client-minted id verbatim', async () => {
    transcript = [];
    const outcome = await executeQueuedContinue(baseRow());
    expect(outcome).toBe('succeeded');
    expect(capturedBodies[0].messageID).toBe(SUBMITTED_WIRE_ID);
  });

  test('a prompt is HELD, not delivered, while a turn is live', async () => {
    // The inbox owns the queue now: a live turn refuses admission and the row
    // goes back on the queue as `queued`, so it stays listed, ordered and
    // removable until the runtime is free.
    //
    // This test used to assert the opposite — that the prompt was delivered
    // mid-turn under a re-minted id. MEASURED 2026-08-21 against a real
    // sandbox, that path is what made the queue uncontrollable: the row read
    // `delivering` within one request of being posted and `DELETE
    // .../prompts/:id` answered 409 "Prompt is already being answered",
    // because OpenCode parents each STEP on the newest user message and the
    // running turn adopts a mid-turn insert almost at once.
    //
    // The re-mint machinery itself stays for now: admission and delivery are
    // two steps, so a turn that opens between them still needs the id lifted.
    // It is a race guard, no longer the normal path.
    boxRow = {
      status: 'active',
      metadata: {
        activeTurns: {
          't-1': {
            token: 't-1',
            state: 'active',
            opencodeSessionId: OC_SESSION_ID,
            messageId: 'msg_other',
            startedAtMs: NOW_MS - 30_000,
          },
        },
      },
    };
    transcript = [
      { info: { id: NEWER_TRANSCRIPT_ID, role: 'assistant', parentID: 'msg_other' } },
    ];

    const outcome = await executeQueuedContinue(baseRow());

    expect(outcome).toBe('queued');
    // Nothing reached OpenCode, so nothing was persisted under any id.
    expect(capturedBodies).toEqual([]);
  });

  test('a second prompt sent inside the persistence lag clears the FIRST one’s id', async () => {
    // The transcript LAGS: OpenCode persists a mid-turn user message ~4s after
    // the POST. Two prompts sent inside that window read the same `newest`, and
    // because a live turn's newest id is younger than WIRE_ID_BACKDATE_MS the
    // mint is LIFTED rather than clocked — so both land on `newest + 1`. The
    // user's own two messages then sort by 14 random base62 characters: either
    // they run in the wrong order, or the loser sorts under an assistant reply
    // and OpenCode never runs it at all.
    //
    // The floor the inbox keeps itself is what separates them: the first
    // prompt's delivered id is on its row before the second one mints.
    const running = OPENCODE_MINTED_ID;
    const firstDelivered = wireIdTime(running)! + BigInt(1);
    deliveredFloor = firstDelivered;
    transcript = [
      // Still only what OpenCode had persisted before the first prompt landed.
      { info: { id: running, role: 'assistant', parentID: 'msg_other' } },
    ];

    const outcome = await executeQueuedContinue(
      baseRow({ result: { admission_reason: 'older_prompt_pending' } }),
    );

    expect(outcome).toBe('succeeded');
    const sent = capturedBodies[0].messageID as string;
    expect(wireIdTime(sent)!).toBeGreaterThan(firstDelivered);
  });

  test('a STOPPED box holds no turn, so an idle send still keeps its id', async () => {
    // Authority dies with the runtime — the same predicate `GET .../turn`
    // serves from. Re-minting here would spend a transcript read on every send
    // to a parked session for nothing.
    boxRow = {
      status: 'stopped',
      metadata: {
        activeTurns: {
          't-1': { token: 't-1', state: 'active', opencodeSessionId: OC_SESSION_ID },
        },
      },
    };
    const outcome = await executeQueuedContinue(baseRow());
    expect(outcome).toBe('succeeded');
    expect(capturedBodies[0].messageID).toBe(SUBMITTED_WIRE_ID);
  });

  test('a redelivery whose prompt was ALREADY ANSWERED is not sent again', async () => {
    // The delivery record proves only that the acceptance write failed. An
    // assistant reply under this message proves the turn ran, so redelivering
    // would run the user's prompt — and spend a real LLM turn — twice.
    transcript = [
      { info: { id: SUBMITTED_WIRE_ID, role: 'user' } },
      {
        info: {
          id: NEWER_TRANSCRIPT_ID,
          role: 'assistant',
          parentID: SUBMITTED_WIRE_ID,
          time: { completed: NOW_MS - 30_000 },
        },
      },
    ];

    const outcome = await executeQueuedContinue(
      baseRow({ payload: { ...baseRow().payload, redeliveries: 1 } }),
    );

    expect(outcome).toBe('succeeded');
    expect(capturedBodies).toEqual([]);
    expect(succeededCalls).toEqual([
      { commandId: 'cmd-1', result: { status: 'skipped', reason: 'already_answered' } },
    ]);
  });

  test('a redelivery whose prompt is still UNANSWERED goes out under a fresh id', async () => {
    transcript = [{ info: { id: SUBMITTED_WIRE_ID, role: 'user' } }];

    const outcome = await executeQueuedContinue(
      baseRow({ payload: { ...baseRow().payload, redeliveries: 1 } }),
    );

    expect(outcome).toBe('succeeded');
    expect(capturedBodies).toHaveLength(1);
    const sent = capturedBodies[0].messageID as string;
    expect(sent).not.toBe(SUBMITTED_WIRE_ID);
    expect(wireIdTime(sent)!).toBeGreaterThan(wireIdTime(SUBMITTED_WIRE_ID)!);
  });
});

describe('drainSessionLifecycleQueue — one lane per session', () => {
  test('a session waiting on a cold box does not hold up anybody else\u2019s prompt', async () => {
    // `continueSession` waits up to READY_DEADLINE_MS (5 min) for a box to come
    // up. Draining the claim sequentially made every prompt in the batch wait
    // behind that — and with every user prompt in the product now going through
    // this queue, that is nine other people's messages.
    let releaseSlow!: () => void;
    openDelayBySession['sess-slow'] = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    claimed = [
      baseRow({ commandId: 'cmd-slow', sessionId: 'sess-slow' }),
      baseRow({ commandId: 'cmd-fast', sessionId: 'sess-fast' }),
    ];

    const drain = drainSessionLifecycleQueue({ limit: 10 });
    // The fast session completes while the slow one is still inside openSession.
    await Bun.sleep(20);
    expect(capturedBodies).toHaveLength(1);
    expect(events).toContain('open:sess-fast');

    releaseSlow();
    const result = await drain;
    expect(result).toMatchObject({ claimed: 2, succeeded: 2 });
    expect(capturedBodies).toHaveLength(2);
  });

  test('two prompts of the SAME session stay in order, one at a time', async () => {
    let releaseFirst!: () => void;
    openDelayBySession['sess-ordered'] = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    claimed = [
      baseRow({ commandId: 'cmd-1', sessionId: 'sess-ordered' }),
      baseRow({ commandId: 'cmd-2', sessionId: 'sess-ordered' }),
    ];

    const drain = drainSessionLifecycleQueue({ limit: 10 });
    await Bun.sleep(20);
    // The second prompt of the session has not been touched yet.
    expect(capturedBodies).toHaveLength(0);

    releaseFirst();
    await drain;
    expect(capturedBodies).toHaveLength(2);
  });
});
