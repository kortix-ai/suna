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
let enqueueDeduped = false;

mock.module('../../config', () => ({
  // LLM_GATEWAY_ENABLED: the model gate's enablement read is AND-gated by the
  // platform flag (resolveFeatureFlag → def.available()); the empty config of
  // the old mock kept every project native and the gate unreachable.
  // DEFAULT_ENABLED stays false so only a project's explicit
  // `experimental.llm_gateway` override turns the gateway on here.
  config: { LLM_GATEWAY_ENABLED: true, LLM_GATEWAY_DEFAULT_ENABLED: false },
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
    return { row: { commandId: 'cmd-1' }, deduped: enqueueDeduped };
  },
  resolveAgentRunAttribution: async () => null,
  resolveProjectAutomationActor: async () => 'actor-1',
  sessionBackpressureState: async () => ({ shouldQueue: false, reason: null }),
}));

// The fire's model gate (KRTX-1505) reads the servable catalog. Mocked with a
// fixture instead of serving it off the db shim: the gate's contract is the
// catalog's `enabled` stamps, not the read models beneath them.
let catalogFixture: { models: Record<string, { name: string; enabled: boolean }> } = { models: {} };
let catalogCalls: Array<Record<string, unknown>> = [];
const realServableCatalog = await import('../../llm-gateway/models/servable-catalog');
mock.module('../../llm-gateway/models/servable-catalog', () => ({
  ...realServableCatalog,
  servableProjectCatalog: async (input: Record<string, unknown>) => {
    catalogCalls.push(input);
    return catalogFixture;
  },
}));

const { fireGitTrigger } = await import('./triggers');

const project = { projectId: 'proj-1', accountId: 'acct-1' } as never;
const gatewayProject = {
  projectId: 'proj-1',
  accountId: 'acct-1',
  metadata: { experimental: { llm_gateway: true } },
} as never;
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
  enqueueDeduped = false;
  catalogFixture = { models: {} };
  catalogCalls = [];
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

  test('reuse mode: the same delivery again answers deduped and kicks no drain (KRTX-1735)', async () => {
    reusableRows = [{ sessionId: 'sess-reuse' }];
    sessionRows = [{ status: 'stopped', metadata: {} }];
    enqueueDeduped = true;

    const result = await fireGitTrigger({
      spec: { ...baseSpec, sessionMode: 'reuse' } as never,
      project,
      payload: {},
      renderedPrompt: 'do the thing',
      source: 'webhook',
      idempotencyKey: 'trigger:webhook:proj-1:daily:evt-1',
    });

    expect(result).toMatchObject({ status: 'queued', sessionId: 'sess-reuse', deduped: true });
    expect(drainCalls).toHaveLength(0);
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
    expect(createCalls[0]).toMatchObject({
      visibility: 'private',
      postCreate: [
        { type: 'apply_trigger_session_access', triggerSlug: 'daily' },
      ],
    });
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

describe('fireGitTrigger — model gate on the fresh-create path (KRTX-1505)', () => {
  const fire = () =>
    fireGitTrigger({
      spec: baseSpec as never,
      project: gatewayProject,
      payload: {},
      renderedPrompt: 'do the thing',
      source: 'cron',
    });

  test('a gateway project with zero enabled models fails the fire before any session is created', async () => {
    catalogFixture = { models: {} };

    const result = await fire();

    expect(result).toMatchObject({
      status: 'failed',
      errorCode: 'no_usable_model',
    });
    expect(result.error).toContain('No usable model');
    expect(createCalls).toHaveLength(0);
    expect(enqueueCalls).toHaveLength(0);
    // The run executes as the automation actor, so its personal keys count.
    expect(catalogCalls).toEqual([
      { projectId: 'proj-1', accountId: 'acct-1', principalUserId: 'actor-1' },
    ]);
  });

  test('a gateway project with one enabled model fires', async () => {
    catalogFixture = { models: { 'kortix/glm-5.3-flash': { name: 'glm-5.3-flash', enabled: true } } };

    const result = await fire();

    expect(result).toMatchObject({ status: 'fired', sessionId: 'sess-new' });
    expect(createCalls).toHaveLength(1);
  });

  test('a native (non-gateway) project with an empty catalog skips the gate', async () => {
    catalogFixture = { models: {} };

    const result = await fireGitTrigger({
      spec: baseSpec as never,
      project,
      payload: {},
      renderedPrompt: 'do the thing',
      source: 'cron',
    });

    expect(result).toMatchObject({ status: 'fired', sessionId: 'sess-new' });
    expect(catalogCalls).toHaveLength(0);
    expect(createCalls).toHaveLength(1);
  });
});
