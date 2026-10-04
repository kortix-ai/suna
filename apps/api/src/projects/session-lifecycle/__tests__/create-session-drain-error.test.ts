// A `create_session` command whose work throws (rather than returning a
// `{status:'failed'}` result) must be dead-lettered/backed-off like every
// other lifecycle command — never left `running` forever.
//
// Prod incident, 2026-09-25 onward: `executeQueuedCreate` can THROW —
// `createProjectSession` -> `loadProjectAgents({ rethrowReadErrors: true })`
// -> `refreshMirror` rethrows a `GitOperationError` when the project's bare
// mirror needs a cold `git clone --bare` and that clone times out
// (`git/mirror.ts` `BARE_CLONE_TIMEOUT_MS`, 90s). Unlike the `continue_session`
// branch just above it, the `create_session` branch in `drain.ts` had no
// `.catch` around `executeQueuedCreate`: the throw escaped uncaught, skipped
// `markCommandFailed` entirely, and left the row `running` under its lease.
// `claimDueLifecycleCommands`'s abandoned-claim reclaim then re-claimed the
// same row every time its lock lapsed and retried the same doomed clone —
// forever, because the 5-attempt dead-letter budget lives inside
// `markCommandFailed`, which this path never reached. Verified in prod:
// `create_session` rows `status='running'` with `attempts` up to 256.
//
// Same mocking caveat as the sibling session-lifecycle test files:
// `mock.module` is process-global in bun:test, so this file runs on its own
// under `--isolate`.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { projectSessions, projects, sessionLifecycleCommands, sessionSandboxes } from '@kortix/db';
import type { SessionLifecycleCommandRow } from '../store';

const ACCOUNT_ID = 'acct-1';
const PROJECT_ID = 'proj-1';
const NOW_MS = Date.now();
const CLONE_TIMEOUT_MESSAGE = 'git clone timed out after 90000ms (signal SIGTERM)';

const cfg: { KORTIX_URL: string; KORTIX_INSTANCE_ID?: string } = { KORTIX_URL: 'https://api.test' };

let claimed: SessionLifecycleCommandRow[] = [];
let failedCalls: Array<{ commandId: string; message: string; retryable: boolean; attempts: number }> = [];
let succeededCalls: string[] = [];

mock.module('../../../lib/config', () => ({
  config: cfg,
  SANDBOX_VERSION: 'test',
}));

mock.module('../../../shared/db', () => ({
  hasDatabase: () => true,
  db: {
    select: (projection?: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (projection && 'result' in projection && 'payload' in projection) return [{ result: {}, payload: {} }];
            if (table === projectSessions) return [];
            if (table === projects) return [{ projectId: PROJECT_ID, accountId: ACCOUNT_ID }];
            if (table === sessionSandboxes) return [];
            if (table === sessionLifecycleCommands && projection && 'newest' in projection) {
              return [{ newest: null }];
            }
            return [];
          },
        }),
      }),
    }),
    update: () => ({
      set: () => ({ where: async () => {} }),
    }),
  },
}));

mock.module('../../session-title-generate', () => ({
  generateSessionTitleFromFirstPrompt: async () => {},
}));
mock.module('../../routes/shared', () => ({
  openSession: async () => {
    throw new Error('not expected: create_session never opens a session in this test');
  },
}));
mock.module('../../../sandbox-proxy/forward', () => ({
  forwardToSandbox: async () => {
    throw new Error('not expected: create_session never forwards a prompt in this test');
  },
}));
// The reproduction: `createProjectSession` THROWS instead of returning
// `{ error }` — exactly what `loadProjectAgents({ rethrowReadErrors: true })`
// does when the mirror's cold clone times out.
mock.module('../../lib/sessions', () => ({
  createProjectSession: async () => {
    throw new Error(CLONE_TIMEOUT_MESSAGE);
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
  requeueForAdmission: async () => {},
  claimCreateSessionCommand: async () => {
    throw new Error('not expected');
  },
  claimDueLifecycleCommands: async () => claimed,
  enqueueContinueSessionCommand: async () => {
    throw new Error('not expected');
  },
  MAX_RUNTIME_UNREACHABLE_RETRIES: 3,
  parkPromptForUnreachableRuntime: async () => ({ parked: true, retries: 1 }),
  reArmRuntimeBlockedPrompts: async () => 0,
  requeueUnlandedPrompt: async () => {
    throw new Error('not expected: this test never fails a landing proof');
  },
  markInboxDeliveryStarted: async () => {},
  markCommandFailed: async (
    row: { commandId: string },
    message: string,
    opts: { retryable: boolean; attempts: number },
  ) => {
    failedCalls.push({ commandId: row.commandId, message, retryable: opts.retryable, attempts: opts.attempts });
  },
  markCommandQueued: async () => {
    throw new Error('not expected');
  },
  markCommandForwarded: async () => {
    throw new Error('not expected: create_session never forwards');
  },
  markCommandSucceeded: async ({ commandId }: { commandId: string }) => {
    succeededCalls.push(commandId);
  },
  withNextDeliveryAttempt: (payload: unknown) => payload,
  withRemintedWireId: (id: string) => JSON.stringify({ redeliveredMessageId: id }),
  resultFromExistingCommand: () => {
    throw new Error('not expected');
  },
}));
mock.module('../instance-release', () => ({
  loadSandboxMetadataForSessions: async () => new Map(),
  releaseCommandToOwningInstance: async () => {},
}));
mock.module('../../opencode-mapping', () => ({
  sandboxOpencodeEndpoint: async () => ({ url: 'https://sandbox.test', headers: {} }),
}));
mock.module('../../../platform/service-key', () => ({
  serviceKeyForExternalId: async () => 'svc-key-1',
}));
mock.module('../../../sandbox-proxy/backend', () => ({
  resolveSandboxIngress: async () => ({ url: 'https://daemon.test', headers: {} }),
  invalidateSandbox: () => {},
}));
mock.module('../../lib/sandbox-env-sync', () => ({
  syncSandboxEnvForPrompt: async () => {},
}));

const { drainSessionLifecycleQueue } = await import('../drain');

function createSessionRow(overrides: Partial<SessionLifecycleCommandRow> = {}): SessionLifecycleCommandRow {
  const now = new Date(NOW_MS);
  return {
    commandId: 'cmd-create-1',
    commandType: 'create_session',
    source: 'ui',
    status: 'running',
    projectId: PROJECT_ID,
    sessionId: null,
    accountId: ACCOUNT_ID,
    actorUserId: null,
    idempotencyKey: null,
    payload: { source: 'ui', body: {} },
    result: {},
    // Already reclaimed several times — asserts the dead-letter budget is
    // enforced (retryable ceases once attempts reaches 5), not just that
    // SOME finalization happens.
    attempts: 5,
    availableAt: now,
    lockedBy: 'worker-x',
    lockedUntil: new Date(NOW_MS + 5 * 60_000),
    lastError: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as SessionLifecycleCommandRow;
}

beforeEach(() => {
  delete cfg.KORTIX_INSTANCE_ID;
  failedCalls = [];
  succeededCalls = [];
  claimed = [createSessionRow()];
});

describe('drainSessionLifecycleQueue — create_session throw is finalized, not left running forever', () => {
  test('a clone-timeout throw from executeQueuedCreate is caught and dead-lettered via markCommandFailed', async () => {
    // The core regression assertion: before the fix, the uncaught throw
    // rejected the whole tick's Promise.all, so this `await` itself threw —
    // and the row was NEVER updated (no markCommandFailed call), leaving it
    // `running` forever for the abandoned-claim reclaim to retry unbounded.
    const result = await drainSessionLifecycleQueue({ limit: 10 });

    expect(failedCalls).toHaveLength(1);
    expect(failedCalls[0]!.commandId).toBe('cmd-create-1');
    expect(failedCalls[0]!.message).toContain(CLONE_TIMEOUT_MESSAGE);
    expect(failedCalls[0]!.attempts).toBe(5);
    // 5 attempts already spent: markCommandFailed's own budget dead-letters
    // here rather than re-queuing a 6th attempt.
    expect(failedCalls[0]!.retryable).toBe(true);
    expect(succeededCalls).toEqual([]);
    expect(result.claimed).toBe(1);
    expect(result.failed).toBe(1);
  });

  test('a clone-timeout throw on an early attempt is retried with backoff, not dead-lettered outright', async () => {
    claimed = [createSessionRow({ commandId: 'cmd-create-2', attempts: 1 })];

    const result = await drainSessionLifecycleQueue({ limit: 10 });

    expect(failedCalls).toHaveLength(1);
    expect(failedCalls[0]!.commandId).toBe('cmd-create-2');
    expect(failedCalls[0]!.attempts).toBe(1);
    expect(failedCalls[0]!.retryable).toBe(true);
    expect(result.failed).toBe(1);
  });
});
