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
let failedCalls: Array<{
  commandId: string;
  message: string;
  options?: { retryable?: boolean };
}> = [];
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
let promptResponsePlan: Array<'failed' | 'deduplicated'> = [];
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
          const limit = async () => {
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
    method: string,
    path: string,
    query: string,
    _headers: Headers,
    body?: ArrayBuffer,
  ) => {
    const messageMatch = /\/message\/([^/]+)$/.exec(path);
    if (method === 'GET' && messageMatch) {
      legacyMessageReads.push({ method, path, query });
      const message = legacyRuntimeMessages[decodeURIComponent(messageMatch[1]!)];
      return message ? Response.json(message) : new Response(null, { status: 404 });
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
      capturedBodies.push(JSON.parse(new TextDecoder().decode(body)));
      const plannedResponse = promptResponsePlan.shift();
      if (plannedResponse === 'failed') return new Response(null, { status: 500 });
      if (plannedResponse === 'deduplicated') {
        return Response.json({ status: 'duplicate', deduplicated: true });
      }
      if (promptDeduplicationsRemaining > 0) {
        promptDeduplicationsRemaining -= 1;
        return Response.json({ deduplicated: true });
      }
      if (promptFailuresRemaining > 0) {
        promptFailuresRemaining -= 1;
        return new Response(null, { status: 500 });
      }
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
  requeueForAdmission: async (commandId: string, reason: string, availableAt: Date) => {
    requeues.push({ commandId, reason, availableAt });
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
  parkPromptForUnreachableRuntime: async () => ({ parked: true, retries: 1 }),
  reArmRuntimeBlockedPrompts: async () => 0,
  markCommandFailed: async (
    commandId: string,
    message: string,
    options?: { retryable?: boolean },
  ) => {
    failedCalls.push({ commandId, message, options });
  },
  markCommandQueued: async () => {
    throw new Error('not expected');
  },
  markCommandForwarded: async (commandId: string, sessionId: string, wireMessageId: string) => {
    forwardedCalls.push({ commandId, sessionId, wireMessageId });
  },
  markCommandSucceeded: async (commandId: string, result: unknown) => {
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

// The wake path now converges the box before every delivery (engine.ts
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
  requeues = [];
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
  promotionCalls = [];
  promotionResult = null;
  claimInputs = [];
  promotionResults = [];
  targetedClaims = new Map();
  activePosts = 0;
  maxActivePosts = 0;
  postDelayMs = 0;
  simulatedInFlightCommands.clear();
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
    expect(legacyMessageReads).toEqual([
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
    // relay (`routes/r4.ts`), which is the only place that knows the answer is
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
    // `routes/r4.ts` awaits `promoteNextInboxRow` and kicks exactly this.
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
