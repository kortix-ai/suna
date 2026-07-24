// fireGitTrigger() pinned/reuse paths must hand the prompt off DURABLY.
//
// The prod incident: these paths called continueSession() directly in-process;
// a 'pending' outcome (runtime never ready inside the deadline) was terminal —
// no session_lifecycle_commands row, no retry, no error log, prompt silently
// gone. These tests pin the fix: an existing live session gets a durable
// continue_session command (drained with retry/backoff, dead-lettered loudly),
// while a dead/failed session still falls through to the fresh-create path.
//
// Mocks `../session-lifecycle`, `../../shared/db`, and `../../config` via
// `mock.module` — process-global in bun:test, so run this file in its own
// `bun test <file>` invocation (as CI does), same caveat as
// ../sandbox-reaper.test.ts.
import { beforeEach, describe, expect, mock, test } from 'bun:test';

let reusableRows: Array<{ sessionId: string }> = [];
let sessionRows: Array<{ status: string; metadata: Record<string, unknown> }> = [];
let enqueueCalls: Array<Record<string, unknown>> = [];
let drainCalls: Array<Record<string, unknown>> = [];
let createCalls: Array<Record<string, unknown>> = [];

mock.module('../../config', () => ({
  config: {},
  SANDBOX_VERSION: 'test',
  KNOWN_PROVIDERS: ['daytona'],
  KORTIX_MARKUP: 1.2,
  PLATFORM_FEE_MARKUP: 0.1,
  getToolCost: () => 0,
}));

mock.module('../../shared/db', () => ({
  hasDatabase: false,
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          // findReusableTriggerSession: where().orderBy().limit()
          orderBy: () => ({ limit: async () => reusableRows }),
          // enqueueTriggerPrompt liveness pre-check: where().limit()
          limit: async () => sessionRows,
        }),
      }),
    }),
  },
}));

mock.module('../session-lifecycle', () => ({
  createSession: async (command: Record<string, unknown>) => {
    createCalls.push(command);
    return {
      status: 'created',
      sessionId: 'sess-new',
      row: { sessionId: 'sess-new', agentName: 'default' },
    };
  },
  drainSessionLifecycleQueue: async (input: Record<string, unknown>) => {
    drainCalls.push(input);
    return { claimed: 0, succeeded: 0, failed: 0, queued: 0 };
  },
  enqueueContinueSessionCommand: async (input: Record<string, unknown>) => {
    enqueueCalls.push(input);
  },
  resolveAgentRunAttribution: async () => null,
  resolveProjectAutomationActor: async () => 'actor-1',
  sessionBackpressureState: async () => ({ shouldQueue: false, reason: null }),
}));

const { fireGitTrigger } = await import('./triggers');

const project = { projectId: 'proj-1', accountId: 'acct-1' } as never;
const baseSpec = {
  slug: 'daily',
  type: 'cron',
  enabled: true,
  agent: 'default',
  model: null,
  cron: '0 9 * * *',
  promptTemplate: 'do the thing',
} as Record<string, unknown>;

beforeEach(() => {
  reusableRows = [];
  sessionRows = [];
  enqueueCalls = [];
  drainCalls = [];
  createCalls = [];
});

describe('fireGitTrigger — durable prompt delivery', () => {
  test('reuse mode with a live canonical session enqueues a durable command and kicks a drain', async () => {
    reusableRows = [{ sessionId: 'sess-reuse' }];
    sessionRows = [{ status: 'stopped', metadata: {} }];

    const result = await fireGitTrigger({
      spec: { ...baseSpec, sessionMode: 'reuse' } as never,
      project,
      payload: {},
      renderedPrompt: 'do the thing',
      source: 'cron',
      idempotencyKey: 'trigger:cron:proj-1:daily:slot-1',
    });

    expect(result).toMatchObject({ status: 'queued', sessionId: 'sess-reuse' });
    expect(enqueueCalls).toHaveLength(1);
    expect(enqueueCalls[0]).toMatchObject({
      source: 'trigger:cron',
      projectId: 'proj-1',
      accountId: 'acct-1',
      sessionId: 'sess-reuse',
      actorUserId: 'actor-1',
      text: 'do the thing',
      triggerSlug: 'daily',
      idempotencyKey: 'trigger:cron:proj-1:daily:slot-1',
    });
    // Immediate-feel fast path; the scheduler tick is the durable guarantee.
    expect(drainCalls).toHaveLength(1);
    // No direct/fresh session creation happened.
    expect(createCalls).toHaveLength(0);
  });

  test('pinned mode targets the pinned session', async () => {
    sessionRows = [{ status: 'running', metadata: {} }];

    const result = await fireGitTrigger({
      spec: { ...baseSpec, sessionMode: 'pinned', pinnedSessionId: 'sess-pin' } as never,
      project,
      payload: {},
      renderedPrompt: 'do the thing',
      source: 'manual',
    });

    expect(result).toMatchObject({ status: 'queued', sessionId: 'sess-pin' });
    expect(enqueueCalls).toHaveLength(1);
    expect(enqueueCalls[0]).toMatchObject({ sessionId: 'sess-pin', source: 'trigger:manual' });
    expect(createCalls).toHaveLength(0);
  });

  test('a failed canonical session is NOT enqueued into — falls through to a fresh session', async () => {
    reusableRows = [{ sessionId: 'sess-dead' }];
    sessionRows = [{ status: 'failed', metadata: {} }];

    const result = await fireGitTrigger({
      spec: { ...baseSpec, sessionMode: 'reuse' } as never,
      project,
      payload: {},
      renderedPrompt: 'do the thing',
      source: 'cron',
    });

    expect(enqueueCalls).toHaveLength(0);
    expect(createCalls).toHaveLength(1);
    expect(result).toMatchObject({ status: 'fired', sessionId: 'sess-new' });
  });

  test('a deleted canonical session is NOT enqueued into — falls through to a fresh session', async () => {
    reusableRows = [{ sessionId: 'sess-deleted' }];
    sessionRows = [{ status: 'stopped', metadata: { deletedAt: new Date().toISOString() } }];

    const result = await fireGitTrigger({
      spec: { ...baseSpec, sessionMode: 'reuse' } as never,
      project,
      payload: {},
      renderedPrompt: 'do the thing',
      source: 'cron',
    });

    expect(enqueueCalls).toHaveLength(0);
    expect(createCalls).toHaveLength(1);
    expect(result).toMatchObject({ status: 'fired', sessionId: 'sess-new' });
  });
});
