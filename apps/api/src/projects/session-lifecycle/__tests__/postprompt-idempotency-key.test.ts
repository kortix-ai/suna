// F2 — two DISTINCT queued `continue_session` commands with byte-identical
// prompt text (two approvals of one actionPath; a fixed-text trigger firing
// twice inside the 10-minute dedupe TTL) must both reach opencode. Before
// this fix, `postPrompt` sent no `messageID` and no `Idempotency-Key`, so
// `prompt-dedupe.ts`'s key fell all the way to its content hash —
// `sandboxId` + `sessionId` + body bytes — which is IDENTICAL for two
// different commands that happen to share the same text. The second command
// was answered `200 {"deduplicated":true}`, `postPrompt` read that as
// delivered, and the second command's turn silently never ran.
//
// The fix: `postPrompt` now sends `Idempotency-Key: <row.commandId>` —
// stable across every retry of ONE command (the row's identity never
// changes), and distinct across different commands even when their text
// matches exactly. `promptDeliveryKey` (prompt-dedupe.ts) already prefers an
// explicit Idempotency-Key over the content hash — see
// `prompt-dedupe.test.ts`'s "prefers a trimmed Idempotency-Key over the
// content hash" — so this alone restores both-deliver semantics without
// touching the dedupe module itself.
//
// Same mocking caveat as the sibling engine.ts test files: `mock.module` is
// process-global in bun:test, so this file must run on its own (the repo's
// `--isolate` test runner already guarantees that).
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { projectSessions, projects } from '@kortix/db';
import type { SessionLifecycleCommandRow } from '../store';

const SESSION_ID = 'sess-idem-key-1';
const ACCOUNT_ID = 'acct-1';
const PROJECT_ID = 'proj-1';
const EXTERNAL_ID = 'sandbox-1';
const OC_SESSION_ID = 'oc-1';

let sessionRow: Record<string, unknown> | null = null;
let capturedIdempotencyKeys: Array<string | null> = [];
let succeededCalls: Array<{ commandId: string; result: unknown }> = [];
let failedCalls: Array<{ commandId: string; message: string }> = [];

mock.module('../../../config', () => ({
  config: { KORTIX_URL: 'https://api.test' },
  SANDBOX_VERSION: 'test',
}));

mock.module('../../../shared/db', () => ({
  hasDatabase: () => true,
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === projectSessions) return sessionRow ? [sessionRow] : [];
            if (table === projects) return [{ projectId: PROJECT_ID, accountId: ACCOUNT_ID }];
            return [];
          },
        }),
      }),
    }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
  },
}));

mock.module('../../session-title-generate', () => ({
  generateSessionTitleFromFirstPrompt: async () => {},
}));

mock.module('../../routes/shared', () => ({
  openSession: async () => ({
    stage: 'ready',
    sandbox: { external_id: EXTERNAL_ID, provider: 'daytona' },
    opencode_session_id: OC_SESSION_ID,
  }),
}));

// The one call site F2 fixes: capture the header `postPrompt` sends instead
// of actually reaching a sandbox.
mock.module('../../../sandbox-proxy/routes/preview', () => ({
  forwardToSandbox: async (
    _externalId: string,
    _port: number,
    _access: unknown,
    _method: string,
    _path: string,
    _query: string,
    incomingHeaders: Headers,
  ) => {
    capturedIdempotencyKeys.push(incomingHeaders.get('idempotency-key'));
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
  // The prompt inbox's admission refusal — `executeQueuedContinue` calls it
  // before anything else, so every store mock has to carry it or the engine
  // import fails outright.
  requeueForAdmission: async () => {
    throw new Error('not expected: this test never refuses admission');
  },
  claimCreateSessionCommand: async () => {
    throw new Error('not expected');
  },
  claimDueLifecycleCommands: async () => {
    throw new Error('not expected');
  },
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
  // Every row in this file is an AUTOMATION continue (an approval resume): no
  // client-minted wire id, so the ledger has nothing to key a consumption
  // confirmation on and the row closes through `markCommandSucceeded` exactly
  // as it always did. Reaching the forwarded path here would be the bug.
  markCommandForwarded: async () => {
    throw new Error('not expected: a prompt with no wire id must not stay open');
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

// No staged revert on this session row — the guard reads via
// `sandboxOpencodeEndpoint`; returning null makes it fail open (see
// `queued-continue-staged-revert.test.ts`) so this file stays focused on the
// idempotency key, not the revert guard.
mock.module('../../opencode-mapping', () => ({
  sandboxOpencodeEndpoint: async () => null,
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
  syncSessionRuntimesEnvForPrompt: async () => {},
}));

const { executeQueuedContinue, continueSession } = await import('../engine');

function baseRow(overrides: Partial<SessionLifecycleCommandRow> = {}): SessionLifecycleCommandRow {
  const now = new Date('2026-08-16T00:00:00.000Z');
  return {
    commandId: 'cmd-1',
    commandType: 'continue_session',
    source: 'approval',
    status: 'running',
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    accountId: ACCOUNT_ID,
    actorUserId: null,
    idempotencyKey: null,
    payload: { text: 'please approve and continue' },
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
  capturedIdempotencyKeys = [];
  succeededCalls = [];
  failedCalls = [];
});

describe('F2 — postPrompt Idempotency-Key', () => {
  test('RED: two DIFFERENT commands, byte-identical text, both deliver with DISTINCT keys', async () => {
    const first = await executeQueuedContinue(
      baseRow({ commandId: 'cmd-a', payload: { text: 'please approve and continue' } }),
    );
    const second = await executeQueuedContinue(
      baseRow({ commandId: 'cmd-b', payload: { text: 'please approve and continue' } }),
    );

    expect(first).toBe('succeeded');
    expect(second).toBe('succeeded');
    expect(failedCalls).toEqual([]);
    expect(succeededCalls).toEqual([
      { commandId: 'cmd-a', result: { status: 'delivered' } },
      { commandId: 'cmd-b', result: { status: 'delivered' } },
    ]);
    expect(capturedIdempotencyKeys).toEqual(['cmd-a', 'cmd-b']);
    expect(capturedIdempotencyKeys[0]).not.toBe(capturedIdempotencyKeys[1]);
  });

  test('a retry of the SAME command sends the SAME key both times (stable, so a genuine retry still dedupes)', async () => {
    await executeQueuedContinue(baseRow({ commandId: 'cmd-c' }));
    await executeQueuedContinue(baseRow({ commandId: 'cmd-c' }));

    expect(capturedIdempotencyKeys).toEqual(['cmd-c', 'cmd-c']);
  });

  test('a direct (non-queued) continueSession call with no commandId still sends a key', async () => {
    // `applyPostCreateActions`'s non-retryable create path and every direct
    // channel caller (Slack, email, voice, triggers) have no durable row of
    // their own — `continueSession` falls back to a fresh `randomUUID()` per
    // call so `postPrompt` never sends an empty header.
    const outcome = await continueSession({
      source: 'ui',
      sessionId: SESSION_ID,
      text: 'hello',
    });

    expect(outcome).toBe('delivered');
    expect(capturedIdempotencyKeys).toHaveLength(1);
    expect(capturedIdempotencyKeys[0]).toBeTruthy();
    expect(capturedIdempotencyKeys[0]).not.toBe('cmd-a');
  });
});
