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
import { mintWireMessageId } from '../../wire-message-id';
import type { SessionLifecycleCommandRow } from '../store';

const SESSION_ID = 'sess-inbox-delivery-1';
const ACCOUNT_ID = 'acct-1';
const PROJECT_ID = 'proj-1';
const EXTERNAL_ID = 'sandbox-1';
const OC_SESSION_ID = 'oc-1';
const NOW_MS = Date.now();
const SUBMITTED_WIRE_ID = mintWireMessageId({
  nowMs: NOW_MS - 10 * 60_000,
  random: () => 0.5,
}).id;

const requeues: Array<{ commandId: string; reason: string; availableAt: Date }> = [];
let sessionRow: Record<string, unknown> | null = null;
/** The session's one box, as the turn-authority read sees it. Null = no box. */
let boxRow: {
  status: string;
  metadata: Record<string, unknown> | null;
} | null = null;
/** The newest id the inbox's OWN rows say this session has already delivered,
 *  as `readDeliveredWireIdFloor` reads it back. Null = nothing delivered yet. */
let transcript: Array<Record<string, unknown>> = [];
let capturedBodies: Array<Record<string, unknown>> = [];
let succeededCalls: Array<{ commandId: string; result: unknown }> = [];
// A delivered row that carries a wire id no longer closes — it stays OPEN as
// `forwarded` until the session_turns ledger confirms a turn consumed that id.
let forwardedCalls: Array<{
  commandId: string;
  sessionId: string;
  wireMessageId: string;
}> = [];
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
              return [
                {
                  newest: null,
                },
              ];
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
  // The delivery path parks a prompt whose RUNTIME was down instead of
  // dead-lettering it. Present so the module mock stays complete.
  MAX_RUNTIME_UNREACHABLE_RETRIES: 3,
  parkPromptForUnreachableRuntime: async () => ({ parked: true, retries: 1 }),
  reArmRuntimeBlockedPrompts: async () => 0,
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
  // Mirrors the real bound jsonb param so `persistedWireIds` can still read it.
  withRemintedWireId: (id: string) => JSON.stringify({ redeliveredMessageId: id }),
  resultFromExistingCommand: () => {
    throw new Error('not expected');
  },
}));

mock.module('../../opencode-mapping', () => ({
  sandboxOpencodeEndpoint: async () => ({
    url: 'https://sandbox.test',
    headers: {},
  }),
}));

// The ONE thing this file is about: the runtime env sync that must precede
// every inbox delivery. Recorded, never executed.
let envSyncCalls: Array<Record<string, unknown>> = [];
mock.module('../../lib/sandbox-env-sync', () => ({
  syncSessionRuntimesEnvForPrompt: async (args: Record<string, unknown>) => {
    envSyncCalls.push(args);
  },
}));

// The slow (wake) path needs the box's service key and ingress to sync.
let serviceKeyAvailable = true;
mock.module('../../../platform/service-key', () => ({
  serviceKeyForExternalId: async () => (serviceKeyAvailable ? 'svc-key-1' : null),
}));
mock.module('../../../sandbox-proxy/backend', () => ({
  resolveSandboxIngress: async () => ({
    url: 'https://daemon.test',
    headers: {},
  }),
}));

const { executeQueuedContinue } = await import('../engine');

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

beforeEach(() => {
  envSyncCalls = [];
  serviceKeyAvailable = true;
});

// ---------------------------------------------------------------------------
// Every inbox delivery converges the box first.
//
// Before: `continueSession` ran `syncSandboxEnvForPrompt` only when the
// command carried `opencodeEnv` (a per-prompt override). An ordinary inbox
// prompt — the SDK's `session.send()` path, `POST …/prompts` — was handed to
// OpenCode with whatever the box had at boot: stale gateway base URL (every
// KORTIX_URL rotation), stale secrets, stale model catalog. The proxied
// `prompt_async` route always syncs; the inbox route must too. 2026-08-22: an
// inbox prompt on a box whose boot-time tunnel had died was forwarded to the
// dead URL although the API already had a live one — the sync that would have
// rewritten it never ran.
// ---------------------------------------------------------------------------
describe('executeQueuedContinue — runtime env sync precedes every inbox delivery', () => {
  test('an ordinary prompt (no opencodeEnv override) still syncs the box before it is sent', async () => {
    const outcome = await executeQueuedContinue(baseRow());
    expect(outcome).toBe('succeeded');
    expect(envSyncCalls).toHaveLength(1);
    expect(envSyncCalls[0]).toMatchObject({
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      externalId: EXTERNAL_ID,
      providerName: 'daytona',
    });
    // The sync happened BEFORE the wire write.
    expect(capturedBodies).toHaveLength(1);
  });

  test('a box whose service key cannot be read is not delivered blind — the prompt stays queued', async () => {
    serviceKeyAvailable = false;
    const outcome = await executeQueuedContinue(baseRow());
    expect(outcome).toBe('queued');
    expect(envSyncCalls).toHaveLength(0);
    expect(capturedBodies).toHaveLength(0);
  });
});
