// What the drain puts ON THE WIRE for an inbox prompt.
//
// Three claims, each of which has a way of failing silently:
//
//  1. A prompt whose only content is an attachment (no text at all) is a legal
//     send — the composer allows it and the POST route accepts it — so the
//     drain must deliver it instead of dead-lettering it as "missing text".
//  2. A prompt posted during a live turn must be re-minted before it goes out.
//     The running turn has written messages with HIGHER ids than the client id,
//     and OpenCode reads a lower id as already answered — the turn silently
//     never runs.
//  3. A redelivery must prove the prompt is still unanswered. A `delivering`
//     record is only evidence that the ACCEPTANCE write failed; if the
//     transcript shows an assistant reply under that message, the turn ran and
//     re-sending it would run the user's message a second time.
//
// Same mocking caveat as the sibling session-lifecycle test files: `mock.module` is
// process-global in bun:test, so this file must run on its own (the repo's
// `--isolate` test runner already guarantees that).
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realInboxDeliveryHold from '../inbox-delivery-hold';
import { projectSessions, projects, sessionLifecycleCommands, sessionSandboxes } from '@kortix/db';
import type { SessionLifecycleCommandRow } from '../store';
import { drizzle } from 'drizzle-orm/pg-proxy';
import type { SQL } from 'drizzle-orm';
import { isWireIdAheadOf, mintWireMessageId, wireIdTime } from '../../wire-message-id';

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

let completeDuringRequeue = false;
let deliveryStarts: string[] = [];
/** `deliveryStarts.length` at each POST — proves when the group was published. */
let startsAtPost: number[] = [];
let requeues: Array<{ commandId: string; reason: string; availableAt: Date }> = [];
let unverifiedRequeues: Array<{ commandId: string; availableAt: Date }> = [];
let unlandedRequeues: Array<{ commandId: string; reason: string }> = [];
let unlandedBudgetLeft = 2;
let sessionRow: Record<string, unknown> | null = null;
let projectMetadataExpression: SQL | undefined;
/** The session's one box, as the turn-authority read sees it. Null = no box. */
let boxRow: { status: string; metadata: Record<string, unknown> | null } | null = null;
/** The newest id the inbox's OWN rows say this session has already delivered,
 *  as `readDeliveredWireIdFloor` reads it back. Null = nothing delivered yet. */
let deliveredFloor: bigint | null = null;
let transcript: Array<Record<string, unknown>> = [];
/** This session's inbox rows, as the under-placement send-order gate resolves
 *  a transcript id to the row that put it on the wire (`readInboxRowsByWireIds`).
 *  Every row is answered; the helper itself maps ids to rows. */
let inboxRows: Array<{
  commandId: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown>;
  createdAt: Date;
}> = [];
/** What the drain's sibling sweep SEES queued for this session — the rows the
 *  claim itself did not take because their `available_at` was still out. */
let sweepQueued: Array<Record<string, unknown>> = [];
/** What each sweep CAS answers, in order. An empty answer is a row another
 *  worker took first: the sweep leaves it, and it becomes the run's gap. */
let sweepClaims: Array<Array<Record<string, unknown>>> = [];
let capturedBodies: Array<Record<string, unknown>> = [];
let quickQueueControlRequests: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
let capturedKeys: string[] = [];
const seenKeys = new Set<string>();
let succeededCalls: Array<{ commandId: string; result: unknown }> = [];
// A delivered row that carries a wire id no longer closes — it stays OPEN as
// `forwarded` until the session_turns ledger confirms a turn consumed that id.
let forwardedCalls: Array<{ commandId: string; sessionId: string; wireMessageId: string }> = [];
let failedCalls: Array<{
  commandId: string;
  message: string;
  options?: { retryable?: boolean; failureCode?: string };
}> = [];
/** What `parkPromptForUnreachableRuntime` answers. `parked: false` is a spent
 *  runtime-unreachable budget, which the drain dead-letters. */
let parkOutcome = { parked: true, retries: 1 };
let payloadPatches: Array<Record<string, unknown>> = [];
let claimed: SessionLifecycleCommandRow[] = [];
let openDelayBySession: Record<string, Promise<void> | undefined> = {};
let events: string[] = [];
let runtimeWrites: Array<{ targetPath: string; filename: string; mime: string }> = [];
let runtimeWriteError: Error | null = null;
let legacyPendingFirst: {
  commandId: string;
  deliveredMessageIds: string[];
  parts: Array<Record<string, unknown>>;
} | null = null;
let legacyRuntimeMessages: Record<string, Record<string, unknown>> = {};
let legacyMessageReads: Array<{ method: string; path: string; query: string }> = [];
let legacyPartUpdates: Array<{
  method: string;
  path: string;
  query: string;
  body: Record<string, unknown>;
}> = [];
let legacyRepairMarks = 0;
let legacyRepairMarkerFailuresRemaining = 0;
let legacyPendingLoads = 0;
let promptFailuresRemaining = 0;
let promptDeduplicationsRemaining = 0;
let promptResponsePlan: Array<'failed' | 'deduplicated' | 'permanent-refusal' | 'connector-required' | 'out-of-credits'> =
  [];
// Models the sandbox edge DISCARDING an oversized body while answering ok: the
// POST is captured, but the runtime never holds that message. Scoped to the
// FIRST posted id, so the delivery's retry lands and the test does not have to
// sit out the loop's 45s deadline.
let runtimeDropsFirstDelivery = false;
let promotionCalls: string[] = [];
let promotionResult: string | null = null;
let claimInputs: Array<{ idempotencyKey?: string }> = [];
let promotionResults: Array<string | null> = [];
let targetedClaims = new Map<string, SessionLifecycleCommandRow[]>();
let activePosts = 0;
let maxActivePosts = 0;
let postDelayMs = 0;
// Models the real database state after a drain claims same-session siblings:
// every claimed row is `running` until the drain releases the tail.
const simulatedInFlightCommands = new Set<string>();

let pauseAfterPosts: number | null = null;
mock.module('../../../config', () => ({
  config: { KORTIX_URL: 'https://api.test' },
  SANDBOX_VERSION: 'test',
}));

mock.module('../../../shared/db', () => ({
  hasDatabase: () => true,
  db: {
    select: (projection?: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: () => {
          if (projection?.projectMetadata) projectMetadataExpression = projection.projectMetadata as SQL;
          const limit = async () => {
            // The drain's SIBLING SWEEP (`claimDueSessionInboxSiblings`): the
            // only read of this table that projects nothing — it selects whole
            // rows. It answers with the session's remaining QUEUED inbox rows,
            // whatever their `available_at`.
            if (table === sessionLifecycleCommands && !projection) return sweepQueued;
            // The send-order gate's row lookup: keyed on its projection (it is
            // the only read of this table that selects `createdAt`). Before the
            // hold read below, which keys on `result` + `payload` alone.
            if (table === sessionLifecycleCommands && projection && 'createdAt' in projection) {
              return inboxRows;
            }
            if (projection && 'result' in projection && 'payload' in projection) {
              return [{ result: { held: pauseAfterPosts !== null && capturedBodies.length >= pauseAfterPosts }, payload: {} }];
            }
            if (table === projectSessions) return sessionRow ? [sessionRow] : [];
            if (table === projects) return [{ projectId: PROJECT_ID, accountId: ACCOUNT_ID }];
            if (table === sessionSandboxes) return boxRow ? [boxRow] : [];
            // The aggregate `readDeliveredWireIdFloor` runs: always one row,
            // with a null when the session has never delivered anything.
            // Keyed on the PROJECTION, not the table: the admission gate reads
            // the same table for a different question, and answering it with a
            // floor row would make every send look like it lost the order race.
            if (table === sessionLifecycleCommands && projection && 'newest' in projection) {
              // FAITHFUL TO THE REAL QUERY: `readDeliveredWireIdFloor` takes
              // GREATEST over `payload.redeliveredMessageId` too, and the drain
              // persists a re-minted id BEFORE its POST. A static floor let two
              // rows of one group mint inside the same millisecond and collide
              // on the clock — a harness artefact (3 of 4 runs), since the real
              // floor always sees the sibling's id.
              const persisted = persistedWireIds()
                .map((id) => wireIdTime(id))
                .filter((clock): clock is bigint => clock !== null);
              const floor = [deliveredFloor, ...persisted].reduce<bigint | null>(
                (max, clock) => (clock !== null && (max === null || clock > max) ? clock : max),
                null,
              );
              return [{ newest: floor === null ? null : floor.toString() }];
            }
            if (
              table === sessionLifecycleCommands &&
              projection &&
              'commandId' in projection &&
              simulatedInFlightCommands.size > 0
            ) {
              return [{ commandId: [...simulatedInFlightCommands][0] }];
            }
            return [];
          };
          return { limit, orderBy: () => ({ limit }) };
        },
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        payloadPatches.push(values);
        // Awaitable AND `.returning()`-able: the sibling sweep's claim is a
        // CAS UPDATE … RETURNING, and it takes the row only when a row comes
        // back. `sweepClaims` is the per-row answer, in sweep order.
        const where = () =>
          Object.assign(Promise.resolve([]), {
            returning: async () => sweepClaims.shift() ?? [],
          });
        return { where };
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
    method: string,
    path: string,
    query: string,
    _headers: Headers,
    body?: ArrayBuffer,
  ) => {
    const messageMatch = /\/message\/([^/]+)$/.exec(path);
    if (method === 'GET' && messageMatch) {
      legacyMessageReads.push({ method, path, query });
      const requestedId = decodeURIComponent(messageMatch[1]!);
      const message = legacyRuntimeMessages[requestedId];
      if (message) return Response.json(message);
      // The delivery's LANDING PROOF reads back the id it just posted
      // (`prompt-landing-proof.ts`). A real runtime holds any message it
      // accepted, so the harness answers for every id this session actually
      // posted; only ids never posted 404, which is what lets a test assert a
      // silently-dropped delivery.
      const posted = capturedBodies.some((sent) => sent.messageID === requestedId);
      const dropped =
        runtimeDropsFirstDelivery && requestedId === (capturedBodies[0]?.messageID as string);
      if (posted && !dropped) {
        return Response.json({ info: { id: requestedId }, parts: [] });
      }
      return new Response(null, { status: 404 });
    }
    if (method === 'PATCH' && path.includes('/part/')) {
      legacyPartUpdates.push({
        method,
        path,
        query,
        body: JSON.parse(new TextDecoder().decode(body)),
      });
      return Response.json({ ok: true });
    }
    activePosts += 1;
    maxActivePosts = Math.max(maxActivePosts, activePosts);
    try {
      if (postDelayMs > 0) await Bun.sleep(postDelayMs);
      // The real proxy takes a 10-minute dedupe claim on the Idempotency-Key
      // of every prompt POST and answers a repeat `200 {deduplicated:true}` —
      // WITHOUT forwarding it. A harness that forwarded repeats let a retry
      // under the same key look like a delivery (review finding, 2026-09-05).
      const idempotencyKey = _headers.get('Idempotency-Key') ?? '';
      capturedKeys.push(idempotencyKey);
      if (idempotencyKey && seenKeys.has(idempotencyKey)) {
        return Response.json({ status: 'duplicate', deduplicated: true });
      }
      capturedBodies.push(JSON.parse(new TextDecoder().decode(body)));
      startsAtPost.push(deliveryStarts.length);
      // The claim outlives only a delivery the daemon ACCEPTED: a 5xx is
      // provable non-delivery and the real proxy releases it, so a retry under
      // the same key after a 500 is forwarded again, not deduped.
      const remember = () => {
        if (idempotencyKey) seenKeys.add(idempotencyKey);
      };
      const plannedResponse = promptResponsePlan.shift();
      // A permanent runtime refusal: any 4xx the classifier treats as terminal
      // (`throwIfPromptRefused` — not 404/408/409/429). The old fixture answered
      // 409 CONNECTOR_CONNECTION_REQUIRED, which no route emits since the
      // session connector gate was retired (2026-09-16); a 409 is retryable now.
      if (plannedResponse === 'permanent-refusal') return Response.json({ code: 'PROMPT_REJECTED', message: 'The runtime rejected this prompt.' }, { status: 422 });
      // The same terminal shape, carrying a connector code, so the stored
      // failure keeps its `connector_required` cause for the queue list.
      if (plannedResponse === 'connector-required') return Response.json({ code: 'CONNECTOR_CONNECTION_REQUIRED', message: 'Create the required connections before continuing this session.' }, { status: 422 });
      if (plannedResponse === 'out-of-credits') return Response.json({ error: 'Out of credits. Top up to continue.', code: 'insufficient_credits' }, { status: 402 });
      if (plannedResponse === 'failed') return new Response(null, { status: 500 });
      if (plannedResponse === 'deduplicated') {
        remember();
        return Response.json({ status: 'duplicate', deduplicated: true });
      }
      if (promptDeduplicationsRemaining > 0) {
        promptDeduplicationsRemaining -= 1;
        remember();
        return Response.json({ deduplicated: true });
      }
      if (promptFailuresRemaining > 0) {
        promptFailuresRemaining -= 1;
        return new Response(null, { status: 500 });
      }
      remember();
      return new Response(null, { status: 204 });
    } finally {
      activePosts -= 1;
    }
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
  promoteNextInboxRow: async (sessionId: string) => {
    promotionCalls.push(sessionId);
    return promotionResults.length > 0 ? (promotionResults.shift() ?? null) : promotionResult;
  },
  loadLegacyPendingFirstPrompt: async () => {
    legacyPendingLoads += 1;
    return legacyPendingFirst;
  },
  markLegacyInlineAttachmentsRepaired: async () => {
    legacyRepairMarks += 1;
    events.push('legacy-marker');
    if (legacyRepairMarkerFailuresRemaining > 0) {
      legacyRepairMarkerFailuresRemaining -= 1;
      throw new Error('marker write failed');
    }
    if (sessionRow) {
      sessionRow.metadata = {
        ...((sessionRow.metadata as Record<string, unknown> | null) ?? {}),
        legacy_inline_attachments_repaired_at: '2026-09-02T00:00:00.000Z',
      };
    }
  },
  requeueUnlandedPrompt: async ({ commandId }: { commandId: string }, reason: string) => {
    unlandedRequeues.push({ commandId, reason });
    simulatedInFlightCommands.delete(commandId);
    if (unlandedBudgetLeft <= 0) return { requeued: false, refusals: 2 };
    unlandedBudgetLeft -= 1;
    return { requeued: true, refusals: 2 - unlandedBudgetLeft };
  },
  MAX_LANDING_RETRIES: 2,
  markInboxDeliveryStarted: async ({ commandId }: { commandId: string }) => { deliveryStarts.push(commandId); },
  requeueUnverifiedRedelivery: async ({ commandId }: { commandId: string }, availableAt: Date) => {
    unverifiedRequeues.push({ commandId, availableAt });
    simulatedInFlightCommands.delete(commandId);
  },
  requeueForAdmission: async ({ commandId }: { commandId: string }, reason: string, availableAt: Date) => {
    requeues.push({ commandId, reason, availableAt });
    if (completeDuringRequeue) boxRow = { status: 'active', metadata: { activeTurns: {} } };
    simulatedInFlightCommands.delete(commandId);
  },
  claimCreateSessionCommand: async () => {
    throw new Error('not expected');
  },
  claimDueLifecycleCommands: async (input: { idempotencyKey?: string }) => {
    claimInputs.push(input);
    return input.idempotencyKey ? (targetedClaims.get(input.idempotencyKey) ?? []) : claimed;
  },
  enqueueContinueSessionCommand: async () => {
    throw new Error('not expected');
  },
  // The delivery path parks a prompt whose RUNTIME was down instead of
  // dead-lettering it. Present so the module mock stays complete.
  MAX_RUNTIME_UNREACHABLE_RETRIES: 3,
  parkPromptForUnreachableRuntime: async () => parkOutcome,
  reArmRuntimeBlockedPrompts: async () => 0,
  markCommandFailed: async (
    { commandId }: { commandId: string },
    message: string,
    options?: { retryable?: boolean; failureCode?: string },
  ) => {
    failedCalls.push({ commandId, message, options });
  },
  markCommandQueued: async () => {
    throw new Error('not expected');
  },
  markCommandForwarded: async ({ commandId }: { commandId: string }, sessionId: string, wireMessageId: string) => {
    forwardedCalls.push({ commandId, sessionId, wireMessageId });
  },
  markCommandSucceeded: async ({ commandId }: { commandId: string }, result: unknown) => {
    events.push('command-succeeded');
    succeededCalls.push({ commandId, result });
  },
  // `inbox-rows.ts` imports this at module load, so the mock has to carry it or
  // the engine import fails outright. Nothing in this file drives a row through
  // it, so an identity pass-through is the whole of it.
  withNextDeliveryAttempt: (payload: unknown) => payload,
  // Mirrors the real bound jsonb param so `persistedWireIds` can still read it.
  withRemintedWireId: (id: string) => JSON.stringify({ redeliveredMessageId: id }),
  resultFromExistingCommand: () => {
    throw new Error('not expected');
  },
}));

mock.module('../../opencode-mapping', () => ({
  sandboxOpencodeEndpoint: async () => ({ url: 'https://sandbox.test', headers: {} }),
}));

// The wake path now converges the box before every delivery (continue-session.ts
// `continueSession`): it reads the service key and ingress and calls
// `syncSandboxEnvForPrompt`. Stubbed here — this file is about what goes on
// the wire, not about the sync (see continue-session-env-sync.test.ts).
mock.module('../../../platform/service-key', () => ({
  serviceKeyForExternalId: async () => 'svc-key-1',
}));
mock.module('../../../sandbox-proxy/backend', () => ({
  resolveSandboxIngress: async () => ({ url: 'https://daemon.test', headers: {} }),
}));
mock.module('../../lib/sandbox-env-sync', () => ({
  syncSandboxEnvForPrompt: async () => {},
}));

mock.module('../runtime-prompt-file', () => ({
  // The materializer imports it for handle-backed parts; these rows carry none.
  importRuntimePromptAttachment: async () => null,
  writeRuntimePromptFile: async (input: {
    targetPath: string;
    filename: string;
    mime: string;
    bytes: Uint8Array;
  }) => {
    if (runtimeWriteError) throw runtimeWriteError;
    runtimeWrites.push({
      targetPath: input.targetPath,
      filename: input.filename,
      mime: input.mime,
    });
    return { path: input.targetPath, size: input.bytes.byteLength };
  },
}));

// The POST's commit (`commitInboxPost`) is an UPDATE … RETURNING this db mock
// cannot answer; its SQL runs against real Postgres in
// `integration-inbox-user-action-race.test.ts`. Here it keeps the read-only
// Stop check the mock does answer.
mock.module('../inbox-delivery-hold', () => ({
  ...realInboxDeliveryHold,
  commitInboxPost: (commandId: string) => realInboxDeliveryHold.assertInboxDeliveryActive(commandId),
}));

const { drainSessionLifecycleQueue } = await import('../drain');
const { executeQueuedContinue } = await import('../queued-continue');

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
  projectMetadataExpression = undefined;
  pauseAfterPosts = null;
  requeues = [];
  unverifiedRequeues = [];
  completeDuringRequeue = false;
  deliveryStarts = [];
  startsAtPost = [];
  unlandedRequeues = [];
  unlandedBudgetLeft = 2;
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
  inboxRows = [];
  sweepQueued = [];
  sweepClaims = [];
  capturedBodies = [];
  quickQueueControlRequests = [];
  capturedKeys = [];
  seenKeys.clear();
  succeededCalls = [];
  forwardedCalls = [];
  failedCalls = [];
  parkOutcome = { parked: true, retries: 1 };
  payloadPatches = [];
  claimed = [];
  openDelayBySession = {};
  events = [];
  runtimeWrites = [];
  runtimeWriteError = null;
  legacyPendingFirst = null;
  legacyRuntimeMessages = {};
  legacyMessageReads = [];
  legacyPartUpdates = [];
  legacyRepairMarks = 0;
  legacyRepairMarkerFailuresRemaining = 0;
  legacyPendingLoads = 0;
  promptFailuresRemaining = 0;
  promptDeduplicationsRemaining = 0;
  promptResponsePlan = [];
  runtimeDropsFirstDelivery = false;
  promotionCalls = [];
  promotionResult = null;
  claimInputs = [];
  promotionResults = [];
  targetedClaims = new Map();
  activePosts = 0;
  maxActivePosts = 0;
  postDelayMs = 0;
  simulatedInFlightCommands.clear();
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.endsWith('/kortix/abort/after-tool')) {
      quickQueueControlRequests.push({
        url: href,
        method: init?.method ?? 'GET',
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return Response.json({ armed: true }, { status: 202 });
    }
    // The staged-revert guard reads the session row; the re-mint and the
    // answered check read the message list.
    if (href.includes('/message')) {
      return new Response(JSON.stringify(transcript), { status: 200 });
    }
    return new Response(JSON.stringify({ id: OC_SESSION_ID }), { status: 200 });
  }) as typeof fetch;
});

describe('executeQueuedContinue — what actually goes on the wire', () => {
  test('the project flag lookup correlates with the outer session under Drizzle single-table rendering', async () => {
    expect(await executeQueuedContinue(baseRow())).toBe('succeeded');
    expect(projectMetadataExpression).toBeDefined();
    const query = drizzle(async () => ({ rows: [] }))
      .select({ projectMetadata: projectMetadataExpression! })
      .from(projectSessions)
      .toSQL();
    expect(query.sql).toContain('p.project_id = "kortix"."project_sessions"."project_id"');
  });

  // WAS: 'Quick Queue arms the active turn boundary after its head is durably
  // queued' — every head Quick Queue prompt ended the running turn. Two
  // contracts replaced it. A Quick Queue prompt now STEERS into the turn, and
  // ends it only when the response is STREAMING TEXT, which has no step
  // boundary a steer could be read at (owner's report, 2026-09-21: the first
  // answer streamed to its last character with the second prompt "working").
  const liveTurn = () => ({
    status: 'active',
    metadata: { activeTurns: {
      't-1': { token: 't-1', state: 'active', opencodeSessionId: OC_SESSION_ID,
        messageId: 'msg_other', startedAtMs: NOW_MS - 30_000 },
    } },
  });
  const openStep = (parts: Array<Record<string, unknown>>) => [
    { info: { id: 'msg_other', role: 'user' }, parts: [{ type: 'text', text: 'tell me about pigeons' }] },
    { info: { id: NEWER_TRANSCRIPT_ID, role: 'assistant', parentID: 'msg_other',
        time: { created: NOW_MS - 29_000 } }, parts },
  ];

  test('Quick Queue typed over STREAMING TEXT ends that response — armed only after the head is durably queued', async () => {
    boxRow = liveTurn();
    // What OpenCode 1.18 serves mid-stream: the text part opened at
    // `text-start` and nothing persisted since.
    transcript = openStep([{ type: 'step-start' }, { type: 'text', text: '', time: { start: NOW_MS - 28_000 } }]);
    const row = baseRow({ payload: { ...baseRow().payload, placement: 'transcript' } });
    expect(await executeQueuedContinue(row)).toBe('queued');
    expect(requeues).toHaveLength(1);
    expect(quickQueueControlRequests).toEqual([{
      url: 'https://sandbox.test/kortix/abort/after-tool',
      method: 'POST',
      body: { prompt_id: 'cmd-1', opencode_session_id: OC_SESSION_ID,
        turn_message_id: 'msg_other' },
    }]);
    // Never forwarded into the turn it is ending.
    expect(capturedBodies).toHaveLength(0);
  });

  test('Quick Queue typed over a RUNNING TOOL steers into the turn and arms nothing', async () => {
    boxRow = liveTurn();
    transcript = openStep([
      { type: 'text', text: 'Let me look.', time: { start: NOW_MS - 28_000, end: NOW_MS - 27_000 } },
      { type: 'tool', tool: 'bash', state: { status: 'running' } },
    ]);
    const row = baseRow({ payload: { ...baseRow().payload, placement: 'transcript' } });
    expect(await executeQueuedContinue(row)).toBe('succeeded');
    expect(requeues).toHaveLength(0);
    expect(quickQueueControlRequests).toHaveLength(0);
    expect(capturedBodies).toHaveLength(1);
  });

  test('Quick Queue steers when the runtime cannot say what the turn is doing', async () => {
    boxRow = liveTurn();
    let phaseReadFailed = false;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      // Only the phase read carries this page size; the drain's own reads pass.
      if (href.includes('/message?') && href.endsWith('&limit=8') && init?.method === 'GET' && !phaseReadFailed) {
        phaseReadFailed = true;
        return new Response('bad gateway', { status: 502 });
      }
      return realFetch(url, init);
    }) as typeof fetch;
    try {
      const row = baseRow({ payload: { ...baseRow().payload, placement: 'transcript' } });
      expect(await executeQueuedContinue(row)).toBe('succeeded');
      expect(phaseReadFailed).toBe(true);
      expect(quickQueueControlRequests).toHaveLength(0);
      expect(capturedBodies).toHaveLength(1);
    } finally {
      // The wrapper is process-wide; a failed assertion must not leave it on.
      globalThis.fetch = realFetch;
    }
  });

  // THE SEND-ORDER GATE ON UNDER-PLACEMENT. Measured 2026-09-22 (preview
  // session "YO" 134c0d27, and locally 6e288d75/822e92a4): two Quick Queue
  // prompts ~1-2 s apart steered into a tool turn. ALPHA was LIFTED to the
  // box clock (id far above every client id); BRAVO then found ALPHA as an
  // open user above its client id and was UNDER-PLACED at that client id —
  // BELOW ALPHA. The SDK orders placed messages by id, so the tab drew BRAVO
  // above ALPHA, and the merged reply (parented on BRAVO, newest by
  // `time.created`) left ALPHA's slot empty at the bottom. Under-placement
  // is right only when every open sibling above was SENT AFTER this prompt.
  test('a steer whose open sibling above was SENT EARLIER is re-minted above it', async () => {
    boxRow = liveTurn();
    // ALPHA's lifted id: minted the way `mintLivePlacement` does, at the box
    // clock — 3 s ago, far above BRAVO's client id (SUBMITTED_WIRE_ID, ~10 min).
    const alphaLifted = `msg_${(((BigInt(NOW_MS - 3_000) * BigInt(0x1000)) & BigInt(0xffffffffffff)).toString(16).padStart(12, '0'))}ALPHAALPHAALPH`;
    const alphaClient = mintWireMessageId({ nowMs: NOW_MS - 10 * 60_000 - 2_000, random: () => 0.4 }).id;
    transcript = [
      ...openStep([{ type: 'tool', tool: 'bash', state: { status: 'running' } }]),
      { info: { id: alphaLifted, role: 'user', time: { created: NOW_MS - 3_000 } }, parts: [{ type: 'text', text: 'ALPHA' }] },
    ];
    inboxRows = [
      {
        commandId: 'cmd-alpha',
        payload: { clientMessageId: 'client-alpha', wireMessageId: alphaClient, redeliveredMessageId: alphaLifted, clientSentAtMs: NOW_MS - 4_000, placement: 'transcript' },
        result: { status: 'forwarded', forwarded_message_id: alphaLifted },
        createdAt: new Date(NOW_MS - 4_000),
      },
    ];
    const bravo = baseRow({
      commandId: 'cmd-bravo',
      payload: { ...baseRow().payload, placement: 'transcript', clientSentAtMs: NOW_MS - 2_000 },
      createdAt: new Date(NOW_MS - 2_000),
    });
    expect(await executeQueuedContinue(bravo)).toBe('succeeded');
    expect(capturedBodies).toHaveLength(1);
    const sent = capturedBodies[0].messageID as string;
    expect(sent).not.toBe(SUBMITTED_WIRE_ID);
    // Above ALPHA's lifted id: the re-mint floors on every id the inbox put
    // on the wire, so send order and id order agree again.
    expect(wireIdTime(sent)!).toBeGreaterThan(wireIdTime(alphaLifted)!);
    expect(persistedWireIds()).toEqual([sent]);
  });

  // The case under-placement was written for, unchanged: P1 (composer lane)
  // waited for the turn; P2 (Quick Queue) steered in LATER and was lifted;
  // P1 goes out afterwards. P2's row was created after P1's, so P1's client
  // id below P2 IS its send position, and P2's step answers both.
  test('a waiting composer prompt is still under-placed below a later steer', async () => {
    const p2Lifted = `msg_${(((BigInt(NOW_MS - 3_000) * BigInt(0x1000)) & BigInt(0xffffffffffff)).toString(16).padStart(12, '0'))}PTWOPTWOPTWOPT`;
    transcript = [
      ...openStep([{ type: 'tool', tool: 'bash', state: { status: 'running' } }]),
      { info: { id: p2Lifted, role: 'user', time: { created: NOW_MS - 3_000 } }, parts: [{ type: 'text', text: 'P2' }] },
    ];
    inboxRows = [
      {
        commandId: 'cmd-p2',
        payload: { clientMessageId: 'client-p2', wireMessageId: mintWireMessageId({ nowMs: NOW_MS - 5_000, random: () => 0.3 }).id, redeliveredMessageId: p2Lifted, clientSentAtMs: NOW_MS - 4_000, placement: 'transcript' },
        result: { status: 'forwarded', forwarded_message_id: p2Lifted },
        createdAt: new Date(NOW_MS - 4_000),
      },
    ];
    const p1 = baseRow({
      commandId: 'cmd-p1',
      payload: { ...baseRow().payload, placement: 'composer', clientSentAtMs: NOW_MS - 10 * 60_000 },
      result: { admission_reason: 'turn_active' },
      createdAt: new Date(NOW_MS - 10 * 60_000),
    });
    expect(await executeQueuedContinue(p1)).toBe('succeeded');
    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].messageID).toBe(SUBMITTED_WIRE_ID);
    expect(persistedWireIds()).toEqual([]);
  });

  test('Queue List waits for the whole turn without arming a boundary interrupt', async () => {
    boxRow = {
      status: 'active',
      metadata: { activeTurns: {
        't-1': { token: 't-1', state: 'active', opencodeSessionId: OC_SESSION_ID,
          messageId: 'msg_other', startedAtMs: NOW_MS - 30_000 },
      } },
    };
    const row = baseRow({ payload: { ...baseRow().payload, placement: 'composer' } });
    expect(await executeQueuedContinue(row)).toBe('queued');
    expect(requeues).toHaveLength(1);
    expect(quickQueueControlRequests).toHaveLength(0);
    expect(capturedBodies).toHaveLength(0);
  });
  test('Stop during a transient delivery failure prevents another POST', async () => {
    promptResponsePlan = ['failed'];
    pauseAfterPosts = 1;
    expect(await executeQueuedContinue(baseRow())).toBe('queued');
    expect(capturedBodies).toHaveLength(1);
    expect(payloadPatches.some((patch) => patch.status === 'queued' && patch.lockedBy === null)).toBe(true);
    expect(failedCalls).toHaveLength(0);
  });

  test('a permanent runtime refusal fails once and retains the actionable error', async () => {
    promptResponsePlan = ['permanent-refusal'];
    expect(await executeQueuedContinue(baseRow())).toBe('failed');
    expect(capturedBodies).toHaveLength(1);
    expect(failedCalls.at(-1)).toMatchObject({
      message: 'The runtime rejected this prompt.',
      options: { retryable: false },
    });
  });

  // Each give-up names its cause as a code, pinned here per producer: the
  // message beside it is prose, and rewording it must not change the code.
  describe('a prompt the drain gives up on records why, as a code', () => {
    test('a connector refusal is `connector_required`', async () => {
      promptResponsePlan = ['connector-required'];
      expect(await executeQueuedContinue(baseRow())).toBe('failed');
      expect(failedCalls).toHaveLength(1);
      expect(failedCalls[0]?.options).toMatchObject({ retryable: false, failureCode: 'connector_required' });
    });

    test('a billing refusal is `out_of_credits`', async () => {
      promptResponsePlan = ['out-of-credits'];
      expect(await executeQueuedContinue(baseRow())).toBe('failed');
      expect(failedCalls).toHaveLength(1);
      expect(failedCalls[0]).toMatchObject({
        message: 'Out of credits. Top up to continue.',
        options: { retryable: false, failureCode: 'out_of_credits' },
      });
    });

    test('a runtime that stays down past its budget is `runtime_unreachable`', async () => {
      sessionRow = { ...sessionRow, status: 'failed' };
      parkOutcome = { parked: false, retries: 3 };
      expect(await executeQueuedContinue(baseRow())).toBe('failed');
      expect(failedCalls).toHaveLength(1);
      expect(failedCalls[0]?.options).toMatchObject({ retryable: false, failureCode: 'runtime_unreachable' });
    });

    test('a session that no longer exists is `session_gone`', async () => {
      sessionRow = { ...sessionRow, metadata: { deletedAt: '2026-09-17T00:00:00.000Z' } };
      expect(await executeQueuedContinue(baseRow())).toBe('failed');
      expect(capturedBodies).toHaveLength(0);
      expect(failedCalls).toHaveLength(1);
      expect(failedCalls[0]?.options).toMatchObject({ retryable: false, failureCode: 'session_gone' });
    });

    test('a prompt that never lands after its budget is `not_landed`', async () => {
      runtimeDropsFirstDelivery = true;
      unlandedBudgetLeft = 0;
      expect(await executeQueuedContinue(baseRow())).toBe('failed');
      expect(failedCalls.at(-1)?.options).toMatchObject({ retryable: false, failureCode: 'not_landed' });
    }, 20_000);
  });

  test('materializes non-native staged files before prompt_async', async () => {
    const outcome = await executeQueuedContinue(
      baseRow({
        payload: {
          text: 'Inspect these files.',
          clientMessageId: 'q_files',
          wireMessageId: SUBMITTED_WIRE_ID,
          parts: [
            { type: 'text', text: 'Inspect these files.' },
            {
              type: 'file',
              mime: 'application/zip',
              filename: 'bundle.zip',
              url: 'data:application/zip;base64,UEsDBA==',
            },
            {
              type: 'file',
              mime: 'text/markdown',
              filename: 'README.md',
              url: 'data:text/markdown;base64,IyBSZWFkbWU=',
            },
            {
              type: 'file',
              mime: 'image/png',
              filename: 'shot.png',
              url: 'data:image/png;base64,iVBORw0KGgo=',
            },
          ],
        },
      }),
    );

    expect(outcome).toBe('succeeded');
    expect(capturedBodies).toHaveLength(1);
    const body = capturedBodies[0];
    expect(body.parts).toEqual([
      { type: 'text', text: 'Inspect these files.' },
      {
        type: 'text',
        text: expect.stringContaining('filename="bundle.zip"'),
      },
      {
        type: 'text',
        text: expect.stringContaining('filename="README.md"'),
      },
      {
        type: 'file',
        mime: 'image/png',
        filename: 'shot.png',
        url: expect.stringMatching(/^data:image\/png;base64,/),
      },
    ]);
    expect(JSON.stringify(body.parts)).not.toContain('application/zip;base64');
    expect(runtimeWrites.map(({ targetPath }) => targetPath)).toEqual([
      '/workspace/uploads/.kortix-inbox/cmd-1/1-bundle.zip',
      '/workspace/uploads/.kortix-inbox/cmd-1/2-README.md',
    ]);
  });

  test('a materialization failure sends no prompt and leaves the row retryable', async () => {
    runtimeWriteError = new Error('disk is full');

    const outcome = await executeQueuedContinue(
      baseRow({
        payload: {
          text: 'Inspect this file.',
          clientMessageId: 'q_broken_file',
          wireMessageId: SUBMITTED_WIRE_ID,
          parts: [
            { type: 'text', text: 'Inspect this file.' },
            {
              type: 'file',
              mime: 'application/zip',
              filename: 'bundle.zip',
              url: 'data:application/zip;base64,UEsDBA==',
            },
          ],
        },
      }),
    );

    expect(outcome).toBe('queued');
    expect(capturedBodies).toEqual([]);
    expect(legacyRepairMarks).toBe(0);
    expect(failedCalls).toEqual([
      {
        commandId: 'cmd-1',
        message: expect.stringContaining('bundle.zip'),
        options: expect.objectContaining({ retryable: true }),
      },
    ]);
  });

  test('repairs the legacy first message once before a later prompt retries delivery', async () => {
    sessionRow!.metadata = {
      pending_prompt: { attachment_names: ['bundle.zip'] },
    };
    legacyPendingFirst = {
      commandId: 'command-first',
      deliveredMessageIds: ['msg-first'],
      parts: [
        { type: 'text', text: 'Inspect this.' },
        {
          type: 'file',
          mime: 'application/zip',
          filename: 'bundle.zip',
          url: 'data:application/zip;base64,UEsDBA==',
        },
      ],
    };
    legacyRuntimeMessages['msg-first'] = {
      info: { id: 'msg-first', role: 'user' },
      parts: [
        { id: 'part-text', type: 'text', text: 'Inspect this.' },
        {
          id: 'part-zip',
          type: 'file',
          mime: 'application/zip',
          filename: 'bundle.zip',
          url: 'data:application/zip;base64,UEsDBA==',
        },
      ],
    };
    promptFailuresRemaining = 1;

    const outcome = await executeQueuedContinue(
      baseRow({
        commandId: 'command-later',
        idempotencyKey: 'prompt:sess-inbox-delivery-1:q_later',
      }),
    );

    expect(outcome).toBe('succeeded');
    expect(capturedBodies).toHaveLength(2);
    expect(legacyRepairMarks).toBe(1);
    // The REPAIR's own read, isolated from the landing proof's read-back of
    // each freshly posted id: what this asserts is that the repair inspects
    // the legacy first message exactly once across a retried delivery.
    expect(legacyMessageReads.filter((read) => read.path.endsWith('/msg-first'))).toEqual([
      {
        method: 'GET',
        path: '/session/oc-1/message/msg-first',
        query: '?directory=%2Fworkspace',
      },
    ]);
    expect(legacyPartUpdates).toEqual([
      {
        method: 'PATCH',
        path: '/session/oc-1/message/msg-first/part/part-zip',
        query: '?directory=%2Fworkspace',
        body: {
          id: 'part-zip',
          sessionID: 'oc-1',
          messageID: 'msg-first',
          type: 'text',
          text: expect.stringContaining('filename="bundle.zip"'),
        },
      },
    ]);
    expect(runtimeWrites.map(({ targetPath }) => targetPath)).toContain(
      '/workspace/uploads/.kortix-inbox/legacy-command-first/1-bundle.zip',
    );
  });

  test('a newly materialized pending-first prompt marks canonical history before a later prompt', async () => {
    sessionRow!.metadata = {
      pending_prompt: { attachment_names: ['README.md'] },
    };
    const stagedParts = [
      { type: 'text' as const, text: 'Inspect this.' },
      {
        type: 'file' as const,
        mime: 'text/markdown',
        filename: 'README.md',
        url: 'data:text/markdown;base64,IyBSZWFkbWU=',
      },
    ];

    const first = await executeQueuedContinue(
      baseRow({
        commandId: 'command-first',
        idempotencyKey: `prompt:${SESSION_ID}:pending-first`,
        payload: {
          text: 'Inspect this.',
          clientMessageId: 'q_first',
          wireMessageId: SUBMITTED_WIRE_ID,
          parts: stagedParts,
        },
      }),
    );
    const canonicalParts = capturedBodies[0].parts as Array<Record<string, unknown>>;
    legacyPendingFirst = {
      commandId: 'command-first',
      deliveredMessageIds: ['msg-first'],
      parts: stagedParts,
    };
    legacyRuntimeMessages['msg-first'] = {
      info: { id: 'msg-first', role: 'user' },
      parts: [
        { id: 'part-text', type: 'text', text: 'Inspect this.' },
        { id: 'part-markdown', ...canonicalParts[1] },
      ],
    };

    const later = await executeQueuedContinue(
      baseRow({
        commandId: 'command-later',
        idempotencyKey: `prompt:${SESSION_ID}:q_later`,
      }),
    );

    expect([first, later]).toEqual(['succeeded', 'succeeded']);
    expect(capturedBodies).toHaveLength(2);
    expect(canonicalParts[1]).toEqual({
      type: 'text',
      text: expect.stringContaining(
        '/workspace/uploads/.kortix-inbox/command-first/1-README.md',
      ),
    });
    expect(legacyPartUpdates).toEqual([]);
    expect(legacyPendingLoads).toBe(0);
    expect(legacyRepairMarks).toBe(1);
  });

  test('an answered canonical pending-first retry is recovered from its transcript before a later prompt', async () => {
    sessionRow!.metadata = {
      pending_prompt: { attachment_names: ['README.md'] },
    };
    const firstPayload = {
      text: 'Inspect this.',
      clientMessageId: 'q_first',
      wireMessageId: SUBMITTED_WIRE_ID,
      parts: [
        { type: 'text' as const, text: 'Inspect this.' },
        {
          type: 'file' as const,
          mime: 'text/markdown',
          filename: 'README.md',
          url: 'data:text/markdown;base64,IyBSZWFkbWU=',
        },
      ],
    };
    legacyRepairMarkerFailuresRemaining = 1;

    const first = await executeQueuedContinue(
      baseRow({
        commandId: 'command-first',
        idempotencyKey: `prompt:${SESSION_ID}:pending-first`,
        payload: firstPayload,
      }),
    );

    expect(first).toBe('queued');
    expect(capturedBodies).toHaveLength(1);
    expect(legacyRepairMarks).toBe(1);
    expect(sessionRow!.metadata).not.toHaveProperty(
      'legacy_inline_attachments_repaired_at',
    );
    const writesAfterFirst = runtimeWrites.slice();
    const canonicalParts = capturedBodies[0].parts as Array<Record<string, unknown>>;
    legacyPendingFirst = {
      commandId: 'command-first',
      deliveredMessageIds: [SUBMITTED_WIRE_ID],
      parts: firstPayload.parts,
    };
    legacyRuntimeMessages[SUBMITTED_WIRE_ID] = {
      info: { id: SUBMITTED_WIRE_ID, role: 'user' },
      parts: [
        { id: 'part-text', type: 'text', text: 'Inspect this.' },
        { id: 'part-markdown', ...canonicalParts[1] },
      ],
    };

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
    const retry = await executeQueuedContinue(
      baseRow({
        commandId: 'command-first',
        idempotencyKey: `prompt:${SESSION_ID}:pending-first`,
        payload: {
          ...firstPayload,
          remintOnDelivery: true,
        },
      }),
    );

    expect(retry).toBe('succeeded');
    expect(capturedBodies).toHaveLength(1);
    expect(legacyRepairMarks).toBe(1);
    expect(succeededCalls).toEqual([
      {
        commandId: 'command-first',
        result: { status: 'skipped', reason: 'already_answered' },
      },
    ]);

    const later = await executeQueuedContinue(
      baseRow({
        commandId: 'command-later',
        idempotencyKey: `prompt:${SESSION_ID}:q_later`,
      }),
    );

    expect(later).toBe('succeeded');
    expect(capturedBodies).toHaveLength(2);
    expect(legacyRepairMarks).toBe(2);
    expect(sessionRow!.metadata).toHaveProperty(
      'legacy_inline_attachments_repaired_at',
    );
    expect(runtimeWrites).toEqual(writesAfterFirst);
    expect(legacyPartUpdates).toEqual([]);
  });

  test('an ambiguously accepted canonical pending-first prompt is recovered from its transcript', async () => {
    sessionRow!.metadata = {
      pending_prompt: { attachment_names: ['README.md'] },
    };
    const stagedParts = [
      { type: 'text' as const, text: 'Inspect this.' },
      {
        type: 'file' as const,
        mime: 'text/markdown',
        filename: 'README.md',
        url: 'data:text/markdown;base64,IyBSZWFkbWU=',
      },
    ];
    // The runtime accepted the first POST but the proxy returned a 500. Its
    // retry hits the same proxy claim and receives only deduplication proof.
    promptResponsePlan = ['failed', 'deduplicated'];

    const first = await executeQueuedContinue(
      baseRow({
        commandId: 'command-first',
        idempotencyKey: `prompt:${SESSION_ID}:pending-first`,
        payload: {
          text: 'Inspect this.',
          clientMessageId: 'q_first',
          wireMessageId: SUBMITTED_WIRE_ID,
          parts: stagedParts,
        },
      }),
    );
    const writesAfterFirst = runtimeWrites.slice();
    const canonicalParts = capturedBodies[0].parts as Array<Record<string, unknown>>;
    legacyPendingFirst = {
      commandId: 'command-first',
      deliveredMessageIds: [SUBMITTED_WIRE_ID],
      parts: stagedParts,
    };
    legacyRuntimeMessages[SUBMITTED_WIRE_ID] = {
      info: { id: SUBMITTED_WIRE_ID, role: 'user' },
      parts: [
        { id: 'part-text', type: 'text', text: 'Inspect this.' },
        { id: 'part-markdown', ...canonicalParts[1] },
      ],
    };

    const later = await executeQueuedContinue(
      baseRow({
        commandId: 'command-later',
        idempotencyKey: `prompt:${SESSION_ID}:q_later`,
      }),
    );

    expect([first, later]).toEqual(['succeeded', 'succeeded']);
    expect(capturedBodies).toHaveLength(3);
    expect(legacyRepairMarks).toBe(1);
    expect(legacyPartUpdates).toEqual([]);
    expect(runtimeWrites).toEqual(writesAfterFirst);
    expect(sessionRow!.metadata).toHaveProperty(
      'legacy_inline_attachments_repaired_at',
    );
  });

  test('a deduplicated legacy pending-first retry does not suppress later repair', async () => {
    sessionRow!.metadata = {
      pending_prompt: { attachment_names: ['bundle.zip'] },
    };
    const legacyParts = [
      { type: 'text' as const, text: 'Inspect this.' },
      {
        type: 'file' as const,
        mime: 'application/zip',
        filename: 'bundle.zip',
        url: 'data:application/zip;base64,UEsDBA==',
      },
    ];
    legacyPendingFirst = {
      commandId: 'command-first',
      deliveredMessageIds: [SUBMITTED_WIRE_ID],
      parts: legacyParts,
    };
    legacyRuntimeMessages[SUBMITTED_WIRE_ID] = {
      info: { id: SUBMITTED_WIRE_ID, role: 'user' },
      parts: [
        { id: 'part-text', type: 'text', text: 'Inspect this.' },
        {
          id: 'part-zip',
          type: 'file',
          mime: 'application/zip',
          filename: 'bundle.zip',
          url: 'data:application/zip;base64,UEsDBA==',
        },
      ],
    };
    promptDeduplicationsRemaining = 1;

    const legacyRetry = await executeQueuedContinue(
      baseRow({
        commandId: 'command-first',
        idempotencyKey: `prompt:${SESSION_ID}:pending-first`,
        payload: {
          text: 'Inspect this.',
          clientMessageId: 'q_first',
          wireMessageId: SUBMITTED_WIRE_ID,
          deliveryAttempt: 1,
          parts: legacyParts,
        },
      }),
    );
    const later = await executeQueuedContinue(
      baseRow({
        commandId: 'command-later',
        idempotencyKey: `prompt:${SESSION_ID}:q_later`,
      }),
    );

    expect([legacyRetry, later]).toEqual(['succeeded', 'succeeded']);
    expect(legacyRepairMarks).toBe(1);
    expect(legacyPartUpdates).toEqual([
      {
        method: 'PATCH',
        path: `/session/${OC_SESSION_ID}/message/${SUBMITTED_WIRE_ID}/part/part-zip`,
        query: '?directory=%2Fworkspace',
        body: {
          id: 'part-zip',
          sessionID: OC_SESSION_ID,
          messageID: SUBMITTED_WIRE_ID,
          type: 'text',
          text: expect.stringContaining('filename="bundle.zip"'),
        },
      },
    ]);
  });

  // The 2026-09-04 incident. The sandbox edge discards a body over its size
  // ceiling and its RETRY answers 200, so `prompt_async` reports acceptance for
  // a request OpenCode never saw. Before the landing proof the drain closed the
  // row `forwarded` on that 200 and the user's message ceased to exist —
  // no message, no turn, no error, inbox row reporting success. A delivery that
  // cannot be read back must NOT close the row.
  test('a prompt the runtime never wrote is not reported as forwarded', async () => {
    // The edge took the body and answered ok; the runtime never wrote it. The
    // POST is captured, the read-back 404s for good.
    runtimeDropsFirstDelivery = true;

    const outcome = await executeQueuedContinue(
      baseRow({
        payload: {
          text: 'HII',
          clientMessageId: 'q_dropped',
          wireMessageId: SUBMITTED_WIRE_ID,
          parts: [{ type: 'text', text: 'HII' }],
        },
      }),
    );

    // ONE POST under this row's key — never a second under the same key,
    // which the proxy would have answered `duplicate` and the old code read
    // as delivery (review finding, 2026-09-05).
    expect(capturedKeys).toEqual(['cmd-1']);
    // Nothing closed the row. It went back on the queue under a FRESH attempt
    // (fresh key + re-mint on the next drain), which is the whole fix.
    expect(forwardedCalls).toEqual([]);
    expect(succeededCalls).toEqual([]);
    expect(unlandedRequeues).toEqual([
      {
        commandId: 'cmd-1',
        reason: 'prompt accepted by the runtime but never became a message',
      },
    ]);
    expect(outcome).toBe('queued');
  }, 20_000);

  // And when the fresh attempts are spent, the user gets an error instead of
  // a spinner: dead-lettered with the one reason that names what happened.
  test('a prompt that never lands after its retry budget is dead-lettered, not delivered', async () => {
    runtimeDropsFirstDelivery = true;
    unlandedBudgetLeft = 0;

    const outcome = await executeQueuedContinue(
      baseRow({
        payload: {
          text: 'HII',
          clientMessageId: 'q_dropped_final',
          wireMessageId: SUBMITTED_WIRE_ID,
          parts: [{ type: 'text', text: 'HII' }],
        },
      }),
    );

    expect(forwardedCalls).toEqual([]);
    expect(outcome).toBe('failed');
    expect(failedCalls.at(-1)).toMatchObject({
      commandId: 'cmd-1',
      message: 'prompt accepted by the runtime but never became a message',
      options: { retryable: false },
    });
  }, 20_000);

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
    // queued behind another prompt delivers the id minted when the user
    // pressed Enter, and OpenCode reads it as already answered.
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

  test('a redelivery whose answered check cannot read the transcript is not re-sent blind', async () => {
    // 2026-09-17, local: a live turn was settled `runtime_gone` and its prompt
    // redelivered. The transcript held two replies to it, but the full read
    // failed and the guard failed open, so the user saw the prompt twice.
    globalThis.fetch = (async (url: string | URL) => {
      const href = String(url);
      if (href.includes('/message')) return new Response('upstream timeout', { status: 504 });
      return new Response(JSON.stringify({ id: OC_SESSION_ID }), { status: 200 });
    }) as typeof fetch;

    const outcome = await executeQueuedContinue(
      baseRow({
        payload: {
          ...baseRow().payload,
          remintOnDelivery: true,
          redeliveries: 1,
          redeliveredMessageIds: [NEWER_TRANSCRIPT_ID],
        },
      }),
    );

    expect(outcome).toBe('queued');
    expect(capturedBodies).toEqual([]);
    expect(unverifiedRequeues).toHaveLength(1);
    expect(unverifiedRequeues[0].availableAt.getTime()).toBeGreaterThan(Date.now());
  });

  test('an answered check that stays unreadable is bounded, so the prompt is not stranded', async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const href = String(url);
      if (href.includes('/message')) return new Response('upstream timeout', { status: 504 });
      return new Response(JSON.stringify({ id: OC_SESSION_ID }), { status: 200 });
    }) as typeof fetch;

    const outcome = await executeQueuedContinue(
      baseRow({
        payload: { ...baseRow().payload, remintOnDelivery: true, redeliveries: 1 },
        result: { answer_check_failures: 3 },
      }),
    );

    expect(outcome).toBe('succeeded');
    expect(unverifiedRequeues).toEqual([]);
    expect(capturedBodies).toHaveLength(1);
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

  test('a prompt READ by a later sibling\'s merged reply is never re-sent', async () => {
    // Live incident 2026-09-22 (three of three steer runs, e.g. session
    // 4f345186): a steered Quick Queue prompt was answered inside ONE merged
    // reply parented on a LATER, under-placed sibling (OpenCode parents each
    // step on the newest user message by `time.created`). Nothing is parented
    // on this prompt's id, so a parent-only check reads it as unanswered and a
    // redelivery — whatever re-queued it — runs it a second, paid time. The
    // box's stamps prove the reply's step began after this prompt was
    // persisted: it was in that step's input.
    const siblingId = mintWireMessageId({ nowMs: NOW_MS - 11 * 60_000, random: () => 0.5 }).id;
    transcript = [
      { info: { id: SUBMITTED_WIRE_ID, role: 'user', time: { created: NOW_MS - 90_000 } } },
      { info: { id: siblingId, role: 'user', time: { created: NOW_MS - 89_000 } } },
      {
        info: {
          id: NEWER_TRANSCRIPT_ID,
          role: 'assistant',
          parentID: siblingId,
          time: { created: NOW_MS - 60_000, completed: NOW_MS - 30_000 },
        },
      },
    ];

    const outcome = await executeQueuedContinue(
      baseRow({
        payload: { ...baseRow().payload, remintOnDelivery: true, redeliveries: 1 },
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

  test('the deliver timeline logs sinceSendMs per mark when the row carries the Send instant', async () => {
    // A first prompt from project home carries `sendStartedAtMs` (the
    // browser's Send press). The `[provision-timeline] deliver` line must turn
    // that into the latency the user waited, per mark. A row without it logs
    // no `sinceSendMs` at all.
    transcript = [];
    const lines: unknown[][] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args);
    };
    try {
      const withSend = await executeQueuedContinue(
        baseRow({
          commandId: 'cmd-since-send',
          payload: { ...baseRow().payload, sendStartedAtMs: Date.now() - 5_000 },
        }),
      );
      const withoutSend = await executeQueuedContinue(baseRow({ commandId: 'cmd-no-send' }));
      expect(withSend).toBe('succeeded');
      expect(withoutSend).toBe('succeeded');
    } finally {
      console.log = originalLog;
    }

    const deliverLine = (prefix: string) =>
      lines.find(
        (args) =>
          typeof args[0] === 'string' &&
          args[0].startsWith(`[provision-timeline] deliver ${prefix}`),
      );
    const withSendLine = deliverLine('cmd-sinc');
    expect(withSendLine).toBeDefined();
    const extra = withSendLine![1] as { sinceSendMs?: Record<string, number | null> };
    expect(extra.sinceSendMs).toBeDefined();
    const values = Object.values(extra.sinceSendMs!);
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(value).not.toBeNull();
      expect(value!).toBeGreaterThanOrEqual(5_000);
    }

    const withoutSendLine = deliverLine('cmd-no-s');
    expect(withoutSendLine).toBeDefined();
    expect(withoutSendLine![1]).not.toHaveProperty('sinceSendMs');
  });

  test('a prompt submitted into a LIVE TURN waits — then goes out re-minted when the turn ends', async () => {
    // REWRITTEN 2026-09-04, and this is the behaviour change, not a fixture
    // tweak. It used to assert the prompt was FORWARDED into the live turn.
    // That is how two queued messages came to share one answer: OpenCode picks
    // new user messages up at step boundaries inside the running turn and
    // "answers everything before it in that step", so "tell me HI" and "tell
    // me bye" queued behind a 13-step turn produced one reply, "bye".
    //
    // The prompt now waits for the turn. Nothing about the RE-MINT changes —
    // the refusal stamps `admission_reason`, which is what `waited` reads, so
    // the delivery after the turn still lifts the id above the transcript tip.
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
    const refused = await executeQueuedContinue(baseRow());

    expect(refused).toBe('queued');
    expect(capturedBodies).toEqual([]);
    expect(requeues.map(({ commandId, reason }) => ({ commandId, reason }))).toEqual([
      { commandId: 'cmd-1', reason: 'turn_active' },
    ]);

    // The daemon's `session.idle` relay ends the turn and promotes this row.
    boxRow = { status: 'active', metadata: { activeTurns: {} } };
    const outcome = await executeQueuedContinue(
      baseRow({ result: { admission_reason: 'turn_active' } }),
    );

    expect(outcome).toBe('succeeded');
    expect(capturedBodies).toHaveLength(1);
    const sent = capturedBodies[0].messageID as string;
    expect(sent).not.toBe(SUBMITTED_WIRE_ID);
    expect(wireIdTime(sent)!).toBeGreaterThan(wireIdTime(NEWER_TRANSCRIPT_ID)!);
    expect(forwardedCalls).toEqual([
      { commandId: 'cmd-1', sessionId: SESSION_ID, wireMessageId: sent },
    ]);
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

  // `kortix sessions send` ≤ 2026-09 minted the HIGH 12 hex digits of the id
  // clock: ~40 days ahead of every id OpenCode writes. POST stamps such a row
  // `remintOnDelivery`; the drain must then place it against the transcript and
  // must never let the far-future value act as a floor.
  const CLI_HIGH_BITS_ID = `msg_${((BigInt(NOW_MS) * BigInt(0x1000)) >> BigInt(8)).toString(16).slice(0, 12)}SyntheticCli03`;

  test('a far-future CLI id goes out re-placed just above the transcript, not ~40 days ahead', async () => {
    transcript = [{ info: { id: OPENCODE_MINTED_ID, role: 'assistant', parentID: 'msg_other' } }];

    const outcome = await executeQueuedContinue(
      baseRow({
        payload: { ...baseRow().payload, wireMessageId: CLI_HIGH_BITS_ID, remintOnDelivery: true },
      }),
    );

    expect(outcome).toBe('succeeded');
    const sent = capturedBodies[0].messageID as string;
    expect(sent).not.toBe(CLI_HIGH_BITS_ID);
    expect(isWireIdAheadOf(sent, NOW_MS)).toBe(false);
    expect(wireIdTime(sent)!).toBeGreaterThan(wireIdTime(OPENCODE_MINTED_ID)!);
  });

  test('a far-future id on an earlier row does not veto the lift above the transcript', async () => {
    deliveredFloor = wireIdTime(CLI_HIGH_BITS_ID);
    transcript = [{ info: { id: OPENCODE_MINTED_ID, role: 'assistant', parentID: 'msg_other' } }];

    const outcome = await executeQueuedContinue(
      baseRow({ result: { admission_reason: 'older_prompt_pending' } }),
    );

    expect(outcome).toBe('succeeded');
    const sent = capturedBodies[0].messageID as string;
    expect(isWireIdAheadOf(sent, NOW_MS)).toBe(false);
    expect(wireIdTime(sent)!).toBeGreaterThan(wireIdTime(OPENCODE_MINTED_ID)!);
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

  test('one drain sends the FIFO head, then targets the promoted sibling', async () => {
    let releaseFirst!: () => void;
    openDelayBySession['sess-ordered'] = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    claimed = [
      baseRow({ commandId: 'cmd-1', sessionId: 'sess-ordered' }),
      baseRow({ commandId: 'cmd-2', sessionId: 'sess-ordered' }),
    ];
    promotionResult = 'queue-next-idempotency-key';
    simulatedInFlightCommands.add('cmd-2');

    const drain = drainSessionLifecycleQueue({ limit: 10 });
    await Bun.sleep(20);
    // The second prompt of the session has not been touched yet.
    expect(capturedBodies).toHaveLength(0);

    releaseFirst();
    await drain;
    expect(capturedBodies).toHaveLength(1);
    expect(requeues.map(({ commandId, reason }) => ({ commandId, reason }))).toEqual([
      { commandId: 'cmd-2', reason: 'older_prompt_pending' },
    ]);
    // AND THE DELIVERY PATH KICKS NOTHING. Promotion belongs to the turn-end
    // relay (`routes/turn-stream.ts`), which is the only place that knows the answer is
    // finished. Promoting on accepted delivery instead made the next row due
    // while this turn was still running — the merge that let two queued
    // messages share one answer — and it was a lost wake besides: the row was
    // claimed mid-turn, refused, and requeued AFTER the relay had already
    // checked the queue, so it waited out the backoff instead.
    await Bun.sleep(300);
    expect(promotionCalls).toEqual([]);
    expect(claimInputs.map((input) => input.idempotencyKey ?? null)).toEqual([null]);
  });

  test('chains three prompts in canonical FIFO order without overlapping posts', async () => {
    const wireA = mintWireMessageId({ nowMs: NOW_MS - 9 * 60_000, random: () => 0.1 }).id;
    const wireB = mintWireMessageId({ nowMs: NOW_MS - 8 * 60_000, random: () => 0.2 }).id;
    const wireC = mintWireMessageId({ nowMs: NOW_MS - 7 * 60_000, random: () => 0.3 }).id;
    const makeRow = (
      commandId: string,
      idempotencyKey: string,
      text: string,
      wireMessageId: string,
      clientSentAtMs: number,
      createdAt: Date,
    ) =>
      baseRow({
        commandId,
        idempotencyKey,
        createdAt,
        payload: {
          ...baseRow().payload,
          text,
          parts: [{ type: 'text', text }],
          clientMessageId: `client-${commandId}`,
          wireMessageId,
          clientSentAtMs,
        },
      });

    // Database arrival order is C, B, A. The client sent A, B, C.
    const rowA = makeRow(
      'cmd-a',
      'queue-a',
      'PROMPT-A',
      wireA,
      NOW_MS - 3_000,
      new Date(NOW_MS + 3_000),
    );
    const rowB = makeRow(
      'cmd-b',
      'queue-b',
      'PROMPT-B',
      wireB,
      NOW_MS - 2_000,
      new Date(NOW_MS + 2_000),
    );
    const rowC = makeRow(
      'cmd-c',
      'queue-c',
      'PROMPT-C',
      wireC,
      NOW_MS - 1_000,
      new Date(NOW_MS + 1_000),
    );
    claimed = [rowC, rowB, rowA];
    simulatedInFlightCommands.add('cmd-b');
    simulatedInFlightCommands.add('cmd-c');
    promotionResults = ['queue-b', 'queue-c', null];
    targetedClaims.set('queue-b', [rowB]);
    targetedClaims.set('queue-c', [rowC]);
    postDelayMs = 10;

    const result = await drainSessionLifecycleQueue({ limit: 10 });
    expect(result).toMatchObject({ claimed: 3, succeeded: 1, queued: 2 });

    // ONE drain sends ONE prompt. The other two are put back — the delivery
    // path no longer chains them, because a chained row lands inside the turn
    // the first prompt just started and gets merged into its step.
    expect(capturedBodies.map((body) => body.messageID)).toEqual([wireA]);
    expect(promotionCalls).toEqual([]);

    // B and C go out on the turn-end relay's targeted drain, one per turn —
    // `routes/turn-stream.ts` awaits `promoteNextInboxRow` and kicks exactly this.
    await drainSessionLifecycleQueue({ idempotencyKey: 'queue-b' });
    await drainSessionLifecycleQueue({ idempotencyKey: 'queue-c' });

    // CANONICAL SEND ORDER, one post at a time: the client sent A, B, C and the
    // database handed them over C, B, A.
    expect(capturedBodies.map((body) => body.messageID)).toEqual([wireA, wireB, wireC]);
    expect(maxActivePosts).toBe(1);
    expect(claimInputs.map((input) => input.idempotencyKey ?? null)).toEqual([
      null,
      'queue-b',
      'queue-c',
    ]);
  });
});


// THE OWNER'S RULE, 2026-09-21: "However many quick queue prompts are being
// added, they should all be sent together to the agent, not one by one. If I
// have 5 prompts in the quick queue they should all be sent together. On the UI
// there won't be any change — they all look separate — but under the hood the
// agent responds to them in a grouped format."
//
// What makes that safe is `noReply` (OpenCode 1.18.23): the user message is
// PERSISTED and no reply starts. So rows 1..N-1 go out with `noReply: true` and
// only row N opens a turn. There is never a second reply to render under the
// wrong prompt — the failure that made the drain send one row per pass.
describe('a Quick Queue GROUP is one grouped turn', () => {
  const wireFor = (offsetMinutes: number, random: number) =>
    mintWireMessageId({ nowMs: NOW_MS - offsetMinutes * 60_000, random: () => random }).id;

  const quickRow = (
    commandId: string,
    text: string,
    wireMessageId: string,
    clientSentAtMs: number,
    extra: { placement?: string | undefined; result?: Record<string, unknown> } = {},
  ) =>
    baseRow({
      commandId,
      idempotencyKey: `queue-${commandId}`,
      result: extra.result ?? {},
      payload: {
        ...baseRow().payload,
        text,
        parts: [{ type: 'text', text }],
        clientMessageId: `client-${commandId}`,
        wireMessageId,
        clientSentAtMs,
        ...('placement' in extra ? { placement: extra.placement } : { placement: 'transcript' }),
      },
    });

  const wireA = wireFor(9, 0.1);
  const wireB = wireFor(8, 0.2);
  const wireC = wireFor(7, 0.3);
  const hintOf = (body: Record<string, unknown>) =>
    (body.parts as Array<{ type: string; text?: string; synthetic?: boolean }>).filter(
      (part) => part.synthetic === true,
    );

  test('three Quick Queue rows: two noReply posts, then ONE reply, all three closed delivered', async () => {
    // Every row of the group is CLAIMED by this drain, and the real
    // `hasInFlightPrompt` excludes exactly those ids (`inbox-admission.ts`), so
    // none of them is "a sibling already on the wire" for the head.
    claimed = [
      quickRow('cmd-c', 'PROMPT-C', wireC, NOW_MS - 1_000),
      quickRow('cmd-a', 'PROMPT-A', wireA, NOW_MS - 3_000),
      quickRow('cmd-b', 'PROMPT-B', wireB, NOW_MS - 2_000),
    ];
    postDelayMs = 5;

    const result = await drainSessionLifecycleQueue({ limit: 10 });
    expect(result).toMatchObject({ claimed: 3, succeeded: 3, queued: 0 });

    // CANONICAL SEND ORDER, one post at a time, ids strictly increasing.
    expect(capturedBodies.map((body) => body.messageID)).toEqual([wireA, wireB, wireC]);
    expect(capturedBodies.map((body) => body.noReply)).toEqual([true, true, undefined]);
    expect(maxActivePosts).toBe(1);

    // ONE turn is opened, by the LAST row. A `noReply` row can never be
    // confirmed by the `session_turns` ledger — no turn names its id — so it is
    // closed `delivered` at acceptance instead of being left `delivering`.
    expect(forwardedCalls.map((call) => call.commandId)).toEqual(['cmd-c']);
    expect(forwardedCalls[0]?.wireMessageId).toBe(wireC);
    expect(succeededCalls).toEqual([
      { commandId: 'cmd-a', result: { status: 'delivered' } },
      { commandId: 'cmd-b', result: { status: 'delivered' } },
    ]);
    expect(requeues).toEqual([]);
  });

  test('the hidden hint rides on row N alone, and names the group size', async () => {
    // Measured 2026-09-04: two user messages merged into one step and only the
    // last was answered. The merge is deliberate now, so it is stated.
    claimed = [
      quickRow('cmd-a', 'PROMPT-A', wireA, NOW_MS - 3_000),
      quickRow('cmd-b', 'PROMPT-B', wireB, NOW_MS - 2_000),
      quickRow('cmd-c', 'PROMPT-C', wireC, NOW_MS - 1_000),
    ];
    await drainSessionLifecycleQueue({ limit: 10 });
    expect(hintOf(capturedBodies[0])).toEqual([]);
    expect(hintOf(capturedBodies[1])).toEqual([]);
    expect(hintOf(capturedBodies[2])).toHaveLength(1);
    expect(hintOf(capturedBodies[2])[0]?.text).toContain('3 messages in a row');
    // The user's own text is untouched and still first.
    expect((capturedBodies[2].parts as Array<{ text?: string }>)[0]?.text).toBe('PROMPT-C');
  });

  test('a group whose HEAD ended a streaming response tells the model not to resume it', async () => {
    // Measured 2026-09-21: five prompts stopped an essay; the grouped reply
    // answered them, then restarted the essay from "P1:". The row that ended
    // the response is the FIRST of the group; the note must ride on the LAST,
    // the only row that opens a reply.
    claimed = [
      quickRow('cmd-a', 'PROMPT-A', wireA, NOW_MS - 3_000, { result: { ended_response: true } }),
      quickRow('cmd-b', 'PROMPT-B', wireB, NOW_MS - 2_000),
      quickRow('cmd-c', 'PROMPT-C', wireC, NOW_MS - 1_000),
    ];
    await drainSessionLifecycleQueue({ limit: 10 });
    expect(hintOf(capturedBodies[0])).toEqual([]);
    expect(hintOf(capturedBodies[1])).toEqual([]);
    const notes = hintOf(capturedBodies[2]).map((part) => part.text ?? '');
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain('3 messages in a row');
    expect(notes[1]).toContain('Do not resume');
  });

  test('a single prompt that ended a streaming response carries the note alone', async () => {
    claimed = [quickRow('cmd-a', 'PROMPT-A', wireA, NOW_MS - 3_000, { result: { ended_response: true } })];
    await drainSessionLifecycleQueue({ limit: 10 });
    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].noReply).toBeUndefined();
    const notes = hintOf(capturedBodies[0]).map((part) => part.text ?? '');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('Do not resume');
  });

  test('N=1 is the ordinary delivery — no noReply, no hint', async () => {
    claimed = [quickRow('cmd-a', 'PROMPT-A', wireA, NOW_MS - 3_000)];
    await drainSessionLifecycleQueue({ limit: 10 });
    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].noReply).toBeUndefined();
    expect(hintOf(capturedBodies[0])).toEqual([]);
    expect(forwardedCalls.map((call) => call.commandId)).toEqual(['cmd-a']);
  });

  test('every waiting Queue List row goes out as ONE group: noReply posts, then one reply', async () => {
    // The owner's rule of 2026-09-24: the Queue List is sent all at once.
    claimed = [
      quickRow('cmd-a', 'LIST-A', wireA, NOW_MS - 3_000, { placement: 'composer' }),
      quickRow('cmd-b', 'LIST-B', wireB, NOW_MS - 2_000, { placement: 'composer' }),
      quickRow('cmd-c', 'LIST-C', wireC, NOW_MS - 1_000, { placement: 'composer' }),
    ];
    const result = await drainSessionLifecycleQueue({ limit: 10 });
    expect(result).toMatchObject({ claimed: 3, succeeded: 3, queued: 0 });
    expect(capturedBodies.map((body) => body.messageID)).toEqual([wireA, wireB, wireC]);
    expect(capturedBodies.map((body) => body.noReply)).toEqual([true, true, undefined]);
    expect(hintOf(capturedBodies[2])[0]?.text).toContain('3 messages in a row');
  });

  test('the WHOLE group is published as delivering before its first post, not row by row', async () => {
    // Reported 2026-09-24: four Queue List prompts appeared one at a time, a
    // "Thinking" row between each. The group is claimed together, but each
    // row was stamped `delivery_started_at` only when its own post began, so
    // GET .../prompts reported them delivering one by one. The head's
    // admission is the group's admission: every row is stamped then.
    claimed = [
      quickRow('cmd-a', 'LIST-A', wireA, NOW_MS - 3_000, { placement: 'composer' }),
      quickRow('cmd-b', 'LIST-B', wireB, NOW_MS - 2_000, { placement: 'composer' }),
      quickRow('cmd-c', 'LIST-C', wireC, NOW_MS - 1_000, { placement: 'composer' }),
    ];
    await drainSessionLifecycleQueue({ limit: 10 });
    expect([...deliveryStarts].sort()).toEqual(['cmd-a', 'cmd-b', 'cmd-c']);
    expect(startsAtPost[0]).toBe(3);
  });

  test('the two lanes never share a group: a Quick Queue group ends at the first Queue List row', async () => {
    claimed = [
      quickRow('cmd-a', 'PROMPT-A', wireA, NOW_MS - 3_000),
      quickRow('cmd-list', 'PROMPT-LIST', wireB, NOW_MS - 2_000, { placement: 'composer' }),
    ];
    simulatedInFlightCommands.add('cmd-list');
    await drainSessionLifecycleQueue({ limit: 10 });
    expect(capturedBodies.map((body) => body.messageID)).toEqual([wireA]);
    expect(capturedBodies[0].noReply).toBeUndefined();
    expect(requeues.map((entry) => entry.commandId)).toEqual(['cmd-list']);
  });

  test('a row with NO placement is never grouped either', async () => {
    claimed = [
      quickRow('cmd-a', 'PROMPT-A', wireA, NOW_MS - 3_000),
      quickRow('cmd-plain', 'PROMPT-PLAIN', wireB, NOW_MS - 2_000, { placement: undefined }),
    ];
    simulatedInFlightCommands.add('cmd-plain');
    await drainSessionLifecycleQueue({ limit: 10 });
    expect(capturedBodies.map((body) => body.messageID)).toEqual([wireA]);
    expect(capturedBodies[0].noReply).toBeUndefined();
    expect(requeues.map((entry) => entry.commandId)).toEqual(['cmd-plain']);
  });

  test('a HELD row is never grouped, and nothing jumps over it', async () => {
    // The user pressed Stop on cmd-b. Skipping it would put cmd-c on the wire
    // ahead of a message they still intend to send.
    claimed = [
      quickRow('cmd-a', 'PROMPT-A', wireA, NOW_MS - 3_000),
      quickRow('cmd-b', 'PROMPT-B', wireB, NOW_MS - 2_000, { result: { held: true } }),
      quickRow('cmd-c', 'PROMPT-C', wireC, NOW_MS - 1_000),
    ];
    simulatedInFlightCommands.add('cmd-b');
    simulatedInFlightCommands.add('cmd-c');
    await drainSessionLifecycleQueue({ limit: 10 });
    expect(capturedBodies.map((body) => body.messageID)).toEqual([wireA]);
    expect(capturedBodies[0].noReply).toBeUndefined();
    expect(requeues.map((entry) => entry.commandId)).toEqual(['cmd-b', 'cmd-c']);
  });

  test('a failed noReply post STOPS the group — row N is never posted, the tail goes back in line', async () => {
    // Order must hold. Posting row N normally after an earlier row of its group
    // failed would answer a group the user never sent, in the wrong order.
    promptResponsePlan = ['permanent-refusal'];
    claimed = [
      quickRow('cmd-a', 'PROMPT-A', wireA, NOW_MS - 3_000),
      quickRow('cmd-b', 'PROMPT-B', wireB, NOW_MS - 2_000),
      quickRow('cmd-c', 'PROMPT-C', wireC, NOW_MS - 1_000),
    ];
    const result = await drainSessionLifecycleQueue({ limit: 10 });
    expect(capturedBodies.map((body) => body.messageID)).toEqual([wireA]);
    expect(capturedBodies[0].noReply).toBe(true);
    expect(failedCalls.map((call) => call.commandId)).toEqual(['cmd-a']);
    expect(forwardedCalls).toEqual([]);
    expect(requeues.map((entry) => entry.commandId)).toEqual(['cmd-b', 'cmd-c']);
    expect(result).toMatchObject({ claimed: 3, failed: 1, queued: 2 });
  });

  test('STEERING a whole group into a live turn: every row placed above the tip, one reply', async () => {
    // The turn is running a TOOL, so the head steers rather than ending it —
    // and the whole pending group steers with it.
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
      { info: { id: 'msg_other', role: 'user' }, parts: [{ type: 'text', text: 'go' }] },
      {
        info: {
          id: NEWER_TRANSCRIPT_ID,
          role: 'assistant',
          parentID: 'msg_other',
          time: { created: NOW_MS - 29_000 },
        },
        parts: [{ type: 'tool', tool: 'bash', state: { status: 'running' } }],
      },
    ];
    claimed = [
      quickRow('cmd-a', 'PROMPT-A', wireA, NOW_MS - 3_000),
      quickRow('cmd-b', 'PROMPT-B', wireB, NOW_MS - 2_000),
    ];

    await drainSessionLifecycleQueue({ limit: 10 });
    expect(quickQueueControlRequests).toHaveLength(0);
    expect(capturedBodies).toHaveLength(2);
    expect(capturedBodies.map((body) => body.noReply)).toEqual([true, undefined]);
    // Both re-minted above the running turn's newest id, in send order.
    const sent = capturedBodies.map((body) => wireIdTime(String(body.messageID)));
    expect(sent[0]).toBeGreaterThan(wireIdTime(NEWER_TRANSCRIPT_ID)!);
    expect(sent[1]).toBeGreaterThan(sent[0]!);
    expect(hintOf(capturedBodies[1])).toHaveLength(1);
    expect(forwardedCalls.map((call) => call.commandId)).toEqual(['cmd-b']);
  });

  // A GROUP IS A CONTIGUOUS FIFO RUN OF THE SESSION'S TRANSCRIPT ROWS.
  //
  // Measured 2026-09-22, 2 of 2 runs ("T3 burst over text"): three Quick Queue
  // prompts typed ~1 s apart over a streaming response ended it; each row was
  // then put back on its OWN clock — the head on the admission gate's
  // compounding backoff, the released siblings on a flat 300 ms from whenever
  // their drain reached them (available_at 47.730 / 49.224 / 47.496 s). The
  // 1 s scheduler drain claims only rows that are DUE, so it took rows 1 and 3
  // and left row 2 in the middle. Nothing told the grouping rule that a row was
  // missing, so rows 1 and 3 went out as one grouped answer and row 2 followed
  // ~3 s later, out of send order — and one prompt was never answered.
  //
  // The sweep is the fix: a drain that holds ONE of a session's inbox rows
  // holds ALL of them, whatever their `available_at`.
  test('a claim with a HOLE sweeps the missing sibling in — all three group, in send order', async () => {
    const rowB = quickRow('cmd-b', 'PROMPT-B', wireB, NOW_MS - 2_000);
    claimed = [
      quickRow('cmd-a', 'PROMPT-A', wireA, NOW_MS - 3_000),
      quickRow('cmd-c', 'PROMPT-C', wireC, NOW_MS - 1_000),
    ];
    sweepQueued = [rowB];
    sweepClaims = [[rowB]];

    const result = await drainSessionLifecycleQueue({ limit: 10 });

    expect(capturedBodies.map((body) => body.messageID)).toEqual([wireA, wireB, wireC]);
    expect(capturedBodies.map((body) => body.noReply)).toEqual([true, true, undefined]);
    expect(hintOf(capturedBodies[2])[0]?.text).toContain('3 messages');
    expect(forwardedCalls.map((call) => call.commandId)).toEqual(['cmd-c']);
    expect(requeues).toEqual([]);
    expect(result).toMatchObject({ claimed: 3, succeeded: 3, queued: 0 });
  });

  // A GROUP MINTS AS ONE.
  //
  // Measured 2026-09-22 on a real sandbox (session 37eb6e96): the group was
  // [Request 1, Request 2]. Request 1 had waited out the interrupt, so it was
  // LIFTED above the transcript to `msg_0ca6ad25f0002V…`; Request 2 was claimed
  // fresh, nothing said it had waited, and it went out under its own client id
  // `msg_0ca6a8a77003Qo…` — BELOW its predecessor. The SDK orders placed
  // messages by id, so the tab drew Request 2 above Request 1. Both were
  // answered; the order was wrong.
  test('a group whose HEAD was lifted lifts its tail too — ids ascend in send order', async () => {
    transcript = [
      { info: { id: SUBMITTED_WIRE_ID, role: 'user' } },
      { info: { id: NEWER_TRANSCRIPT_ID, role: 'assistant', parentID: 'msg_other' } },
    ];
    const head = quickRow('cmd-a', 'PROMPT-A', wireA, NOW_MS - 3_000);
    (head.payload as Record<string, unknown>).remintOnDelivery = true;
    claimed = [head, quickRow('cmd-b', 'PROMPT-B', wireB, NOW_MS - 2_000)];

    await drainSessionLifecycleQueue({ limit: 10 });

    const sent = capturedBodies.map((body) => String(body.messageID));
    expect(sent).toHaveLength(2);
    expect(sent[0]).not.toBe(wireA);
    // The tail may NOT keep its client id: the head is now above it.
    expect(sent[1]).not.toBe(wireB);
    expect(wireIdTime(sent[0])!).toBeGreaterThan(wireIdTime(NEWER_TRANSCRIPT_ID)!);
    expect(wireIdTime(sent[1])!).toBeGreaterThan(wireIdTime(sent[0])!);
  });

  test('a group where NOTHING waited keeps every client id', async () => {
    claimed = [
      quickRow('cmd-a', 'PROMPT-A', wireA, NOW_MS - 3_000),
      quickRow('cmd-b', 'PROMPT-B', wireB, NOW_MS - 2_000),
    ];

    await drainSessionLifecycleQueue({ limit: 10 });

    expect(capturedBodies.map((body) => body.messageID)).toEqual([wireA, wireB]);
  });

  test('a sibling the sweep CANNOT take breaks the run — nothing jumps over it', async () => {
    // Another worker won the CAS, so row B is on the wire somewhere else. The
    // group stops at the gap; row C goes back in line rather than overtaking B.
    claimed = [
      quickRow('cmd-a', 'PROMPT-A', wireA, NOW_MS - 3_000),
      quickRow('cmd-c', 'PROMPT-C', wireC, NOW_MS - 1_000),
    ];
    sweepQueued = [quickRow('cmd-b', 'PROMPT-B', wireB, NOW_MS - 2_000)];
    sweepClaims = [[]];

    await drainSessionLifecycleQueue({ limit: 10 });

    expect(capturedBodies.map((body) => body.messageID)).toEqual([wireA]);
    expect(capturedBodies[0].noReply).toBeUndefined();
    expect(hintOf(capturedBodies[0])).toHaveLength(0);
    expect(requeues.map((entry) => entry.commandId)).toEqual(['cmd-c']);
  });
});

test('a turn ending during admission requeue immediately wakes the head again', async () => {
  boxRow = { status: 'active', metadata: { activeTurns: {
    't-1': { token: 't-1', state: 'active', opencodeSessionId: OC_SESSION_ID,
      messageId: 'msg_other', startedAtMs: NOW_MS - 30_000 },
  } } };
  completeDuringRequeue = true;
  promotionResult = 'queue-resumed';
  targetedClaims.set('queue-resumed', [baseRow({ result: { admission_reason: 'turn_active' } })]);
  expect(await executeQueuedContinue(baseRow())).toBe('queued');
  await Bun.sleep(20);
  expect(promotionCalls).toEqual([SESSION_ID]);
  expect(claimInputs).toContainEqual(expect.objectContaining({ idempotencyKey: 'queue-resumed' }));
  expect(capturedBodies).toHaveLength(1);
  expect(deliveryStarts).toEqual(['cmd-1']);
});

test('a refused claim never announces delivery', async () => {
  boxRow = { status: 'active', metadata: { activeTurns: {
    't-1': { token: 't-1', state: 'active', opencodeSessionId: OC_SESSION_ID,
      messageId: 'msg_other', startedAtMs: NOW_MS - 30_000 },
  } } };
  expect(await executeQueuedContinue(baseRow())).toBe('queued');
  expect(deliveryStarts).toEqual([]);
  expect(promotionCalls).toEqual([]);
});
