// Instance-scoped lifecycle drain on a SHARED database.
//
// 2026-08-22, twice: two local API stacks shared one Supabase, so the
// lifecycle queue was one queue. The instance that dequeued a prompt pushed its
// own (dead) `KORTIX_URL` gateway URL into the OTHER instance's sandbox, and the
// owner's log showed nothing. The drain must hand a claimed command whose
// sandbox belongs to another instance BACK (queued, due in ~2s, never
// dead-lettered, never executed) so the owning instance takes it. With
// `KORTIX_INSTANCE_ID` unset (every deployed env) nothing changes — not even
// the metadata lookup runs.
//
// Same mocking caveat as the sibling engine.ts test files: `mock.module` is
// process-global in bun:test, so this file runs on its own under `--isolate`.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { projectSessions, projects, sessionLifecycleCommands, sessionSandboxes } from '@kortix/db';
import { mintWireMessageId } from '../../wire-message-id';
import type { SessionLifecycleCommandRow } from '../store';

const SESSION_ID = 'sess-scope-1';
const ACCOUNT_ID = 'acct-1';
const PROJECT_ID = 'proj-1';
const EXTERNAL_ID = 'sandbox-1';
const OC_SESSION_ID = 'oc-1';
const NOW_MS = Date.now();
const WIRE_ID = mintWireMessageId({ nowMs: NOW_MS - 10 * 60_000, random: () => 0.5 }).id;

/** Mutable config the engine + instance-scope helper read at call time. */
const cfg: { KORTIX_URL: string; KORTIX_INSTANCE_ID?: string } = { KORTIX_URL: 'https://api.test' };

let sessionRow: Record<string, unknown> | null = null;
let boxRow: { status: string; metadata: Record<string, unknown> | null } | null = null;
/** What `loadSandboxMetadataForSessions` answers, and whether it was asked. */
let ownerMetadataBySession: Map<string, Record<string, unknown> | null> = new Map();
let ownerLookups: string[][] = [];
let releases: Array<{ commandId: string; availableAt: Date; owner: string | null }> = [];
let capturedBodies: Array<Record<string, unknown>> = [];
let succeededCalls: string[] = [];
let forwardedCalls: string[] = [];
let failedCalls: Array<{ commandId: string; message: string }> = [];
let claimed: SessionLifecycleCommandRow[] = [];

mock.module('../../../config', () => ({
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
            if (table === projectSessions) return sessionRow ? [sessionRow] : [];
            if (table === projects) return [{ projectId: PROJECT_ID, accountId: ACCOUNT_ID }];
            if (table === sessionSandboxes) return boxRow ? [boxRow] : [];
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
  openSession: async () => ({
    stage: 'ready',
    sandbox: { external_id: EXTERNAL_ID, provider: 'daytona' },
    opencode_session_id: OC_SESSION_ID,
  }),
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
  // The create test only asserts that the scope step ignores a session-less
  // row; the create itself is allowed to fail into `markCommandFailed`.
  createProjectSession: async () => ({ error: { status: 400, body: { error: 'stub' } } }),
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
  markCommandForwarded: async (commandId: string) => {
    forwardedCalls.push(commandId);
  },
  markCommandSucceeded: async (commandId: string) => {
    succeededCalls.push(commandId);
  },
  withNextDeliveryAttempt: (payload: unknown) => payload,
  // Mirrors the real bound jsonb param so `persistedWireIds` can still read it.
  withRemintedWireId: (id: string) => JSON.stringify({ redeliveredMessageId: id }),
  resultFromExistingCommand: () => {
    throw new Error('not expected');
  },
}));
mock.module('../instance-release', () => ({
  loadSandboxMetadataForSessions: async (sessionIds: string[]) => {
    ownerLookups.push(sessionIds);
    return ownerMetadataBySession;
  },
  releaseCommandToOwningInstance: async (
    commandId: string,
    opts: { availableAt: Date; owner: string | null },
  ) => {
    releases.push({ commandId, availableAt: opts.availableAt, owner: opts.owner });
  },
}));
mock.module('../../opencode-mapping', () => ({
  sandboxOpencodeEndpoint: async () => ({ url: 'https://sandbox.test', headers: {} }),
}));
mock.module('../../../platform/service-key', () => ({
  serviceKeyForExternalId: async () => 'svc-key-1',
}));
mock.module('../../../sandbox-proxy/backend', () => ({
  resolveSandboxIngress: async () => ({ url: 'https://daemon.test', headers: {} }),
}));
mock.module('../../lib/sandbox-env-sync', () => ({
  syncSessionRuntimesEnvForPrompt: async () => {},
}));

const { drainSessionLifecycleQueue } = await import('../engine');

function row(overrides: Partial<SessionLifecycleCommandRow> = {}): SessionLifecycleCommandRow {
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
      wireMessageId: WIRE_ID,
      parts: [{ type: 'text', text: 'say hi' }],
    },
    result: {},
    attempts: 1,
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
  boxRow = { status: 'active', metadata: {} };
  ownerMetadataBySession = new Map();
  ownerLookups = [];
  releases = [];
  capturedBodies = [];
  succeededCalls = [];
  forwardedCalls = [];
  failedCalls = [];
  claimed = [row()];
  globalThis.fetch = (async (url: string | URL) => {
    const href = String(url);
    if (href.includes('/message')) return new Response(JSON.stringify([]), { status: 200 });
    return new Response(JSON.stringify({ id: OC_SESSION_ID }), { status: 200 });
  }) as typeof fetch;
});

describe('drainSessionLifecycleQueue — instance scope', () => {
  test('a command whose sandbox belongs to ANOTHER instance is released, not executed', async () => {
    cfg.KORTIX_INSTANCE_ID = 'wt-a';
    ownerMetadataBySession = new Map([[SESSION_ID, { instanceId: 'primary' }]]);

    const result = await drainSessionLifecycleQueue({ limit: 10 });

    expect(ownerLookups).toEqual([[SESSION_ID]]);
    expect(releases).toHaveLength(1);
    expect(releases[0]!.commandId).toBe('cmd-1');
    expect(releases[0]!.owner).toBe('primary');
    // Back on the queue ~2s out: long enough not to spin, short enough that the
    // owner's 1s drain tick takes it on its next pass.
    const delay = releases[0]!.availableAt.getTime() - Date.now();
    expect(delay).toBeGreaterThan(500);
    expect(delay).toBeLessThanOrEqual(5_000);
    // Never executed, never failed, never dead-lettered.
    expect(capturedBodies).toEqual([]);
    expect(succeededCalls).toEqual([]);
    expect(forwardedCalls).toEqual([]);
    expect(failedCalls).toEqual([]);
    expect(result).toMatchObject({ claimed: 1, released: 1, succeeded: 0, failed: 0, queued: 0 });
  });

  test('a command whose sandbox carries the SAME instance id is executed', async () => {
    cfg.KORTIX_INSTANCE_ID = 'wt-a';
    ownerMetadataBySession = new Map([[SESSION_ID, { instanceId: 'wt-a' }]]);

    const result = await drainSessionLifecycleQueue({ limit: 10 });

    expect(releases).toEqual([]);
    expect(capturedBodies).toHaveLength(1);
    expect(failedCalls).toEqual([]);
    expect(result.released).toBe(0);
  });

  test('a command whose sandbox row carries NO instance id (legacy row) is executed', async () => {
    cfg.KORTIX_INSTANCE_ID = 'wt-a';
    ownerMetadataBySession = new Map([[SESSION_ID, {}]]);

    await drainSessionLifecycleQueue({ limit: 10 });

    expect(releases).toEqual([]);
    expect(capturedBodies).toHaveLength(1);
  });

  test('a session with no sandbox row yet is executed (nothing to be foreign to)', async () => {
    cfg.KORTIX_INSTANCE_ID = 'wt-a';
    ownerMetadataBySession = new Map();

    await drainSessionLifecycleQueue({ limit: 10 });

    expect(releases).toEqual([]);
    expect(capturedBodies).toHaveLength(1);
  });

  test('KORTIX_INSTANCE_ID unset → no lookup at all, foreign-looking rows execute (prod no-op)', async () => {
    ownerMetadataBySession = new Map([[SESSION_ID, { instanceId: 'primary' }]]);

    const result = await drainSessionLifecycleQueue({ limit: 10 });

    expect(ownerLookups).toEqual([]);
    expect(releases).toEqual([]);
    expect(capturedBodies).toHaveLength(1);
    expect(result.released).toBe(0);
  });

  test('a create_session command (no session yet) is never scoped', async () => {
    cfg.KORTIX_INSTANCE_ID = 'wt-a';
    claimed = [
      row({
        commandId: 'cmd-create',
        commandType: 'create_session',
        sessionId: null,
        payload: { source: 'ui', body: {} } as unknown as SessionLifecycleCommandRow['payload'],
      }),
    ];

    await drainSessionLifecycleQueue({ limit: 10 });

    expect(ownerLookups).toEqual([]);
    expect(releases).toEqual([]);
  });
});
