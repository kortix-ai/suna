// JAY-600 / T22 — a queued `continue_session` command (the approval-resume /
// trigger backstop drained by drainSessionLifecycleQueue) must never be the
// prompt that commits a STAGED OpenCode revert. `session.revert` is a
// pointer on the sandbox's live session row — nothing is deleted until the
// next prompt, from ANY producer, commits the truncation. A continue queued
// before the user staged a revert is void for the rewound trajectory once
// the revert lands; delivering it would silently resurrect pre-rewind
// context under the user's own edit.
//
// Pins `executeQueuedContinue`'s new staged-revert guard:
//   - revert present on the sandbox's OpenCode session row -> not delivered,
//     the command is marked succeeded/skipped with `reason: 'staged_revert'`.
//   - no revert -> delivers exactly as before (unchanged path).
//   - the guard's own read failing (no reachable endpoint) fails OPEN -> the
//     no-revert delivery path still runs, so a transient read never blocks a
//     legitimate follow-up.
//   - an INBOX row (one the user typed into the composer) is subject to the
//     guard only when it WAITED and was not explicitly promoted, and is FAILED
//     rather than dropped. See the `inbox prompts across a staged revert` block
//     at the bottom of this file.
//
// Same mocking caveat as ../__tests__/continue-session-title.test.ts:
// `mock.module` is process-global in bun:test, so this file must run on its
// own (the repo's `--isolate` test runner already guarantees that).
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { projectSessions, projects } from '@kortix/db';
import type { SessionLifecycleCommandRow } from '../store';

const SESSION_ID = 'sess-revert-guard-1';
const ACCOUNT_ID = 'acct-1';
const PROJECT_ID = 'proj-1';
const EXTERNAL_ID = 'sandbox-1';
const OC_SESSION_ID = 'oc-1';

let sessionRow: Record<string, unknown> | null = null;
let events: string[] = [];
let succeededCalls: Array<{ commandId: string; result: unknown; sessionId?: string | null }> = [];
// An INBOX row carries a wire id, so a successful delivery leaves it OPEN as
// `forwarded` instead of closing it — see `markCommandForwarded`. The
// automation rows in this file (`baseRow`) have no wire id and still close.
let forwardedCalls: Array<{ commandId: string; sessionId: string; wireMessageId: string }> = [];
let failedCalls: Array<{ commandId: string; message: string; opts: unknown }> = [];
let endpointResult: { url: string; headers: Record<string, string> } | null = {
  url: 'https://sandbox.test',
  headers: {},
};
let sessionInfoBody: unknown = null;
let sessionInfoStatus = 200;

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
  openSession: async () => {
    events.push('open');
    return {
      stage: 'ready',
      sandbox: { external_id: EXTERNAL_ID, provider: 'daytona' },
      opencode_session_id: OC_SESSION_ID,
    };
  },
}));

mock.module('../../../sandbox-proxy/routes/preview', () => ({
  forwardToSandbox: async () => {
    events.push('prompt');
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
  markCommandFailed: async (commandId: string, message: string, opts: unknown) => {
    failedCalls.push({ commandId, message, opts });
  },
  markCommandQueued: async () => {
    throw new Error('not expected');
  },
  markCommandForwarded: async (commandId: string, sessionId: string, wireMessageId: string) => {
    forwardedCalls.push({ commandId, sessionId, wireMessageId });
  },
  markCommandSucceeded: async (
    commandId: string,
    result: unknown,
    sessionId?: string | null,
  ) => {
    succeededCalls.push({ commandId, result, sessionId });
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

// The revert guard reuses this exact helper (`opencode-mapping.ts`'s signed
// sandbox-proxy resolution — the same one `session-transcript.ts` uses) —
// no separate client. Mocking it here isolates the guard from Daytona/
// Platinum ingress resolution, which is exercised elsewhere.
mock.module('../../opencode-mapping', () => ({
  sandboxOpencodeEndpoint: async () => {
    events.push('endpoint');
    return endpointResult;
  },
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

const { executeQueuedContinue } = await import('../engine');

const originalFetch = globalThis.fetch;

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
    payload: { text: 'continue the task' },
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
  events = [];
  succeededCalls = [];
  forwardedCalls = [];
  failedCalls = [];
  endpointResult = { url: 'https://sandbox.test', headers: {} };
  sessionInfoBody = null;
  sessionInfoStatus = 200;
  globalThis.fetch = (async (url: string | URL) => {
    events.push(`fetch:${String(url)}`);
    return new Response(JSON.stringify(sessionInfoBody), { status: sessionInfoStatus });
  }) as typeof fetch;
});

describe('executeQueuedContinue — staged-revert guard', () => {
  test('a staged revert drops the queued continue without delivering', async () => {
    sessionInfoBody = { id: OC_SESSION_ID, revert: { messageID: 'msg-99' } };

    const outcome = await executeQueuedContinue(baseRow());

    expect(outcome).toBe('succeeded');
    expect(succeededCalls).toEqual([
      { commandId: 'cmd-1', result: { status: 'skipped', reason: 'staged_revert' }, sessionId: SESSION_ID },
    ]);
    expect(failedCalls).toEqual([]);
    // The guard ran (it read the sandbox's OpenCode session) but delivery
    // never started — no `open` (openSession) and no `prompt` (postPrompt).
    expect(events).toContain('endpoint');
    expect(events.some((e) => e.startsWith('fetch:'))).toBe(true);
    expect(events).not.toContain('open');
    expect(events).not.toContain('prompt');
  });

  test('no staged revert delivers exactly as before', async () => {
    sessionInfoBody = { id: OC_SESSION_ID };

    const outcome = await executeQueuedContinue(baseRow());

    expect(outcome).toBe('succeeded');
    expect(succeededCalls).toEqual([{ commandId: 'cmd-1', result: { status: 'delivered' }, sessionId: SESSION_ID }]);
    expect(failedCalls).toEqual([]);
    // Guard ran BEFORE delivery, then delivery proceeded normally.
    const endpointIdx = events.indexOf('endpoint');
    const openIdx = events.indexOf('open');
    const promptIdx = events.indexOf('prompt');
    expect(endpointIdx).toBeGreaterThanOrEqual(0);
    expect(openIdx).toBeGreaterThan(endpointIdx);
    expect(promptIdx).toBeGreaterThan(openIdx);
  });

  test('an unreachable sandbox during the revert check fails open and still delivers', async () => {
    endpointResult = null; // sandboxOpencodeEndpoint returns null (no service key / unreachable)

    const outcome = await executeQueuedContinue(baseRow());

    expect(outcome).toBe('succeeded');
    expect(succeededCalls).toEqual([{ commandId: 'cmd-1', result: { status: 'delivered' }, sessionId: SESSION_ID }]);
    // The guard tried (endpoint resolution) but got nothing back, so it never
    // even reached the GET /session/{id} fetch — and delivery still ran.
    expect(events).toContain('endpoint');
    expect(events.some((e) => e.startsWith('fetch:'))).toBe(false);
    expect(events).toContain('open');
    expect(events).toContain('prompt');
  });

  test('a session with no opencode pin yet fails open and still delivers', async () => {
    sessionRow = { ...sessionRow, opencodeSessionId: null };

    const outcome = await executeQueuedContinue(baseRow());

    expect(outcome).toBe('succeeded');
    expect(succeededCalls).toEqual([{ commandId: 'cmd-1', result: { status: 'delivered' }, sessionId: SESSION_ID }]);
    // Never even reached endpoint resolution — the pin check short-circuits first.
    expect(events).not.toContain('endpoint');
    expect(events).toContain('open');
    expect(events).toContain('prompt');
  });
});

// WHICH ROW MAY COMMIT A STAGED REVERT.
//
// The guard was written for the approval-resume / trigger backstop: a continue
// queued BEFORE the user staged a revert, which would resurrect the pre-rewind
// trajectory under the user's own edit.
//
// The REPLACEMENT prompt is the opposite case. `handleConfirmRewind` prefills
// the composer with the rewound text; the user edits it and presses Enter, and
// that prompt IS what commits the staged revert — that is what "edit and
// resend" means. Running the guard on it marked the row
// `succeeded/skipped:staged_revert`, and `GET /prompts` omits succeeded rows,
// so the replacement prompt vanished with no error and every later prompt went
// the same way until the user found the Restore control.
//
// `payload.clientMessageId` alone is NOT the discriminator, because it does not
// separate those two: a composer prompt queued while the session was busy also
// carries one, and delivering IT commits a rewind staged afterwards from any
// other client. The discriminator is whether the row WAITED:
//
//   - a rewind can only be staged on an idle session (`rewind()` throws on a
//     working one), so a row that was refused admission, held by Stop, or
//     otherwise made to wait existed BEFORE the session went idle — it predates
//     any revert that is staged now;
//   - the replacement prompt is sent into that idle session and goes out on its
//     first claim, having never waited;
//   - and `result.promoted` — stamped only by `retryInboxPrompt`, i.e. by the
//     user pointing at one row and pressing "send now" — is an explicit "run
//     THIS one", which outranks everything above and is the way out of a
//     refusal.
//
// A refused composer prompt is FAILED, never dropped: a failed row stays in
// `GET /prompts` with its reason and a retry button, so the user's text is on
// screen and one click from running. Silently marking it succeeded is what lost
// the message.
describe('executeQueuedContinue — inbox prompts across a staged revert', () => {
  function inboxRow(overrides: Partial<SessionLifecycleCommandRow> = {}) {
    return baseRow({
      source: 'ui',
      payload: {
        text: 'do it differently',
        clientMessageId: 'cm_1',
        wireMessageId: 'msg_0198f3a1b2c4AbCdEfGhIjKlMn',
      } as unknown as SessionLifecycleCommandRow['payload'],
      ...overrides,
    });
  }

  /** The prompt the user typed AFTER staging the rewind: idle session, first
   *  claim, no wait markers anywhere. */
  test("a staged revert never drops the user's own replacement prompt", async () => {
    sessionInfoBody = { id: OC_SESSION_ID, revert: { messageID: 'msg-99' } };

    const outcome = await executeQueuedContinue(inboxRow());

    expect(outcome).toBe('succeeded');
    // The row went out and stays OPEN: an inbox prompt carries a wire id, so it
    // reads `delivering` until the ledger says a turn consumed it.
    expect(forwardedCalls).toEqual([
      { commandId: 'cmd-1', sessionId: SESSION_ID, wireMessageId: 'msg_0198f3a1b2c4AbCdEfGhIjKlMn' },
    ]);
    expect(succeededCalls).toEqual([]);
    expect(failedCalls).toEqual([]);
    expect(events).toContain('prompt');
  });

  test('the guard does not even read the sandbox for a never-waited inbox row', async () => {
    // A read that cannot change the outcome is a 5s timeout on the delivery
    // path of every single composer send.
    sessionInfoBody = { id: OC_SESSION_ID, revert: { messageID: 'msg-99' } };

    await executeQueuedContinue(inboxRow());

    expect(events.some((e) => e.startsWith('fetch:'))).toBe(false);
  });

  test('a composer prompt that WAITED does not commit a revert staged after it', async () => {
    // Tab A queued this behind a live turn; the rewind was staged from the CLI,
    // mobile, or a second tab whose list Tab A has not polled yet, so nothing
    // removed the row. Delivering it would truncate at the rewind point and
    // answer against the trajectory the rewind discarded.
    sessionInfoBody = { id: OC_SESSION_ID, revert: { messageID: 'msg-99' } };

    const outcome = await executeQueuedContinue(
      inboxRow({
        payload: {
          text: 'and add tests',
          clientMessageId: 'cm_2',
          wireMessageId: 'msg_0198f3a1b2c4AbCdEfGhIjKlMn',
          remintOnDelivery: true,
        } as unknown as SessionLifecycleCommandRow['payload'],
      }),
    );

    expect(outcome).toBe('failed');
    expect(succeededCalls).toEqual([]);
    // FAILED, not silently succeeded: `GET /prompts` lists failed rows, so the
    // text stays on screen with its reason and a retry button.
    expect(failedCalls).toHaveLength(1);
    expect(failedCalls[0]!.commandId).toBe('cmd-1');
    expect(failedCalls[0]!.message).toContain('rewound');
    expect(failedCalls[0]!.opts).toMatchObject({ retryable: false, sessionId: SESSION_ID });
    expect(events).not.toContain('prompt');
    // It DID read the sandbox — the guard only pays that read for a row that
    // could actually be refused by it.
    expect(events.some((e) => e.startsWith('fetch:'))).toBe(true);
  });

  test('an admission refusal counts as waiting just as `remintOnDelivery` does', async () => {
    sessionInfoBody = { id: OC_SESSION_ID, revert: { messageID: 'msg-99' } };

    const outcome = await executeQueuedContinue(
      inboxRow({ result: { admission_reason: 'older_prompt_pending' } as Record<string, unknown> }),
    );

    expect(outcome).toBe('failed');
    expect(failedCalls).toHaveLength(1);
    expect(events).not.toContain('prompt');
  });

  test('"send now" on a waited row commits the revert — that is what it asked for', async () => {
    // `retryInboxPrompt` stamps `result.promoted` AND `payload.remintOnDelivery`.
    // Without the promoted escape the row would be refused for ever: retrying it
    // re-stamps the very marker the refusal reads.
    sessionInfoBody = { id: OC_SESSION_ID, revert: { messageID: 'msg-99' } };

    const outcome = await executeQueuedContinue(
      inboxRow({
        payload: {
          text: 'and add tests',
          clientMessageId: 'cm_2',
          wireMessageId: 'msg_0198f3a1b2c4AbCdEfGhIjKlMn',
          remintOnDelivery: true,
        } as unknown as SessionLifecycleCommandRow['payload'],
        result: { promoted: true } as Record<string, unknown>,
      }),
    );

    expect(outcome).toBe('succeeded');
    // A re-minted delivery is still a delivery: the row stays open under the id
    // it actually went out with, which is what the ledger will confirm.
    expect(forwardedCalls).toHaveLength(1);
    expect(forwardedCalls[0]!.commandId).toBe('cmd-1');
    expect(succeededCalls).toEqual([]);
    expect(failedCalls).toEqual([]);
    expect(events).toContain('prompt');
  });

  test('a waited composer prompt with NO staged revert delivers normally', async () => {
    sessionInfoBody = { id: OC_SESSION_ID };

    const outcome = await executeQueuedContinue(
      inboxRow({
        payload: {
          text: 'and add tests',
          clientMessageId: 'cm_2',
          wireMessageId: 'msg_0198f3a1b2c4AbCdEfGhIjKlMn',
          remintOnDelivery: true,
        } as unknown as SessionLifecycleCommandRow['payload'],
      }),
    );

    expect(outcome).toBe('succeeded');
    expect(failedCalls).toEqual([]);
    expect(events).toContain('prompt');
  });
});

// Restore the real global fetch so other files in this process (bun runs
// with --isolate, but be defensive) never inherit the stub.
process.on('exit', () => {
  globalThis.fetch = originalFetch;
});
