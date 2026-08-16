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
}));
mock.module('../backpressure', () => ({
  sessionBackpressureState: async () => ({ shouldQueue: false, reason: null }),
}));
mock.module('../store', () => ({
  claimCreateSessionCommand: async () => {
    throw new Error('not expected');
  },
  claimDueLifecycleCommands: async () => {
    throw new Error('not expected');
  },
  enqueueContinueSessionCommand: async () => {
    throw new Error('not expected');
  },
  markCommandFailed: async (commandId: string, message: string, opts: unknown) => {
    failedCalls.push({ commandId, message, opts });
  },
  markCommandQueued: async () => {
    throw new Error('not expected');
  },
  markCommandSucceeded: async (
    commandId: string,
    result: unknown,
    sessionId?: string | null,
  ) => {
    succeededCalls.push({ commandId, result, sessionId });
  },
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

// Restore the real global fetch so other files in this process (bun runs
// with --isolate, but be defensive) never inherit the stub.
process.on('exit', () => {
  globalThis.fetch = originalFetch;
});
