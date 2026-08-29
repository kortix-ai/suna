/**
 * GET /v1/projects/:projectId/sessions/:sessionId/open-bundle — the ONE
 * session-open round trip.
 *
 * Driven through the real Hono app, because every claim here is about a
 * RESPONSE. The legs are mocked at their module boundary (each has its own
 * dedicated test beside it), so what this file falsifies is the bundle's own
 * contract: the gates it applies before reading anything, that it asks each leg
 * ONCE, that a leg that throws degrades to `known: false` instead of failing
 * the paint, and that `held` is derived rather than guessed.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import * as realAccess from '../lib/access';

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '55555555-5555-4555-8555-555555555555';

let loadedProject: { row: Record<string, unknown>; userId: string } | null = null;
let visibleSession: Record<string, unknown> | null = null;
let loadProjectCalls: Array<{ projectId: string; action: string }> = [];
let capabilityCalls: string[] = [];

/** What each leg does on this call. A function so a case can make one throw. */
let turnLeg: () => Promise<unknown>;
let queueLeg: () => Promise<unknown[]>;
let transcriptLeg: (limit: number) => Promise<unknown>;
let modelsLeg: () => Promise<Record<string, unknown>>;
let runtimeLeg: () => Promise<Record<string, unknown>>;
let refreshCalls: Array<Record<string, unknown>> = [];
let legCalls: string[] = [];
let transcriptLimits: number[] = [];
let gatewayEnabled = true;

mock.module('../lib/access', () => ({
  ...realAccess,
  loadProjectForUser: async (_c: unknown, projectId: string, action: string) => {
    loadProjectCalls.push({ projectId, action });
    return loadedProject;
  },
  assertProjectCapability: async (
    _c: unknown,
    _userId: string,
    _accountId: string,
    _projectId: string,
    action: string,
  ) => {
    capabilityCalls.push(action);
  },
  loadVisibleSession: async () => visibleSession,
}));
mock.module('../lib/session-turn-read', () => ({
  readSessionTurnState: async () => {
    legCalls.push('turn');
    return turnLeg();
  },
}));
mock.module('../session-lifecycle/inbox-rows', () => ({
  listInboxPrompts: async () => {
    legCalls.push('queue');
    return queueLeg();
  },
}));
mock.module('../lib/session-transcript', () => ({
  buildSessionTranscriptSyncEnvelope: async (input: { limit: number }) => {
    legCalls.push('transcript');
    transcriptLimits.push(input.limit);
    return transcriptLeg(input.limit);
  },
}));
mock.module('../lib/session-prompt-view', () => ({
  serializePrompt: (row: Record<string, unknown>) => row,
}));
mock.module('../lib/session-runtime-projection', () => ({
  readRuntimeLeg: async () => {
    legCalls.push('runtime');
    return runtimeLeg();
  },
}));
mock.module('../lib/session-runtime-projection-refresh', () => ({
  scheduleRuntimeProjectionRefresh: (target: Record<string, unknown>) => {
    refreshCalls.push(target);
  },
}));
mock.module('../llm-gateway/enablement', () => ({
  projectLlmGatewayEnabled: () => gatewayEnabled,
}));
mock.module('../../llm-gateway/enablement', () => ({
  projectLlmGatewayEnabled: () => gatewayEnabled,
}));
mock.module('../../repositories/model-preferences', () => ({
  getAccountModelDefaults: async () => {
    legCalls.push('models');
    return modelsLeg();
  },
}));
mock.module('../../billing/services/entitlements', () => ({
  accountMayUseManagedModels: async () => true,
}));
mock.module('../../llm-gateway/resolution/default-model', () => ({
  resolveEffectiveModel: async () => ({ model: 'anthropic/claude-sonnet-4-6', source: 'project' }),
}));
mock.module('../../llm-gateway/models/served-managed-models', () => ({
  platformDefaultModelId: () => 'anthropic/claude-sonnet-4-6',
}));
mock.module('../lib/serializers', () => ({
  ...require('../lib/serializers'),
  serializeSession: (row: Record<string, unknown>) => ({ session_id: row.sessionId }),
}));

const { projectsApp } = await import('../lib/app');
await import('./session-open-bundle');

function buildApp() {
  const app = new Hono<{ Variables: { userId: string; authType: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', USER_ID);
    c.set('authType', 'pat');
    await next();
  });
  app.route('/v1/projects', projectsApp);
  return app;
}

function openBundle(query = '', sessionId = SESSION_ID) {
  return buildApp().request(
    `/v1/projects/${PROJECT_ID}/sessions/${sessionId}/snapshot${query}`,
  );
}

const ISO_UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('GET /v1/projects/:projectId/sessions/:sessionId/open-bundle', () => {
  beforeEach(() => {
    loadProjectCalls = [];
    capabilityCalls = [];
    legCalls = [];
    refreshCalls = [];
    transcriptLimits = [];
    gatewayEnabled = true;
    loadedProject = {
      row: { accountId: ACCOUNT_ID, projectId: PROJECT_ID, defaultBranch: 'main', metadata: {} },
      userId: USER_ID,
    };
    visibleSession = {
      row: {
        sessionId: SESSION_ID,
        agentName: 'kortix',
        baseRef: null,
        metadata: {},
        opencodeSessionId: 'ses_root',
      },
      grants: [],
      canManageProject: true,
      ownerIsMachine: false,
    };
    turnLeg = async () => ({ turns: [], last_ended: { turn_token: 't1', end_reason: 'completed', ended_at: null } });
    queueLeg = async () => [];
    transcriptLeg = async () => ({
      available: true,
      reason: null,
      source: 'mirror',
      complete: true,
      captured_at: '2026-08-26T00:00:00.000Z',
      opencode_session_id: 'ses_root',
      message_count: 3,
      messages: [{ info: { id: 'msg_1' }, parts: [] }],
    });
    modelsLeg = async () => ({ account: 'a', agents: {}, projects: { [PROJECT_ID]: 'p' } });
    runtimeLeg = async () => ({
      known: true,
      fresh: true,
      source: 'daemon_push',
      captured_at: '2026-08-26T22:43:49.919Z',
      age_ms: 1_000,
      runtime_running: true,
      epoch: 'bmtaokkdb0piayh',
      seq: 41,
      identity: {
        opencode_session_id: 'ses_root',
        opencode_version: '1.18.23',
        daemon_build: 1756240000,
        agent_config_etag: 'ff8a8b4f',
        head_seq: { ses_root: 2016 },
      },
      state: { agents: { known: true, value: [{ name: 'build' }] } },
    });
  });

  test('rejects a non-UUID session id with 400 before any read', async () => {
    const response = await openBundle('', 'not-a-uuid');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid session id' });
    expect(loadProjectCalls).toEqual([]);
    expect(legCalls).toEqual([]);
  });

  test('rejects an out-of-range transcript window with 400 before any read', async () => {
    const response = await openBundle('?transcript=5000');
    expect(response.status).toBe(400);
    expect(legCalls).toEqual([]);
  });

  test('404s when the project is not loadable for the caller, reading nothing', async () => {
    loadedProject = null;
    const response = await openBundle();
    expect(response.status).toBe(404);
    expect(legCalls).toEqual([]);
  });

  test('404s when the session is not visible to the caller, reading nothing', async () => {
    visibleSession = null;
    const response = await openBundle();
    expect(response.status).toBe(404);
    expect(legCalls).toEqual([]);
  });

  test('404s a soft-deleted session', async () => {
    (visibleSession as any).row.metadata = { deletedAt: '2026-08-26T00:00:00.000Z' };
    const response = await openBundle();
    expect(response.status).toBe(404);
    expect(legCalls).toEqual([]);
  });

  test('reads through the read tier and PROJECT_SESSION_READ, exactly once', async () => {
    await openBundle();
    expect(loadProjectCalls).toEqual([{ projectId: PROJECT_ID, action: 'read' }]);
    expect(capabilityCalls).toEqual(['project.session.read']);
  });

  test('asks every leg exactly once and stamps ONE clock for the envelope', async () => {
    const response = await openBundle();
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(legCalls.sort()).toEqual(['models', 'queue', 'runtime', 'transcript', 'turn']);
    expect(body.observed_at).toMatch(ISO_UTC_MS);
    expect(body.session).toEqual({ session_id: SESSION_ID });
    expect(body.turn).toEqual({
      known: true,
      turns: [],
      last_ended: { turn_token: 't1', end_reason: 'completed', ended_at: null },
    });
    expect(body.queue).toEqual({ known: true, prompts: [], held: false });
    expect(body.transcript.known).toBe(true);
    expect(body.transcript.requested).toBe(true);
    expect(body.transcript.source).toBe('mirror');
    expect(body.transcript.messages).toEqual([{ info: { id: 'msg_1' }, parts: [] }]);
    expect(body.config).toEqual({
      known: true,
      base_ref: 'main',
      agent_name: 'kortix',
      llm_gateway_enabled: true,
    });
    expect(body.models.known).toBe(true);
    expect(body.models.projectDefault).toBe('p');
    expect(body.models.resolvedForCaller).toBe('anthropic/claude-sonnet-4-6');
  });

  test('still answers at /open-bundle — the path every published SDK requests', async () => {
    // #6987 renamed the route to `/snapshot` without moving the SDK's
    // `getSessionOpenBundle`, so every session open 404'd the bundle and
    // silently fell back to 6-8 serial reads. The alias keeps already-shipped
    // clients on the accelerator.
    const response = await buildApp().request(
      `/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}/open-bundle`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.queue).toEqual({ known: true, prompts: [], held: false });
    expect(body.observed_at).toMatch(ISO_UTC_MS);
  });

  test('the envelope clock is captured BEFORE the legs run, not when they settle', async () => {
    // The queue's freshness protocol (JAY-728): a snapshot is no fresher than
    // the moment it was ASKED for. Stamped at response-build time, a slow
    // bundle claimed its reads' settle instant and outranked a direct read
    // issued after it.
    queueLeg = async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return [];
    };
    const response = await openBundle();
    const done = Date.now();
    const body = (await response.json()) as Record<string, any>;
    expect(Date.parse(body.observed_at)).toBeLessThanOrEqual(done - 25);
  });

  test('defaults the transcript window to the SDK first-paint span', async () => {
    await openBundle();
    expect(transcriptLimits).toEqual([40]);
  });

  test('transcript=0 asks for the pointer only and never reads the mirror', async () => {
    const body = (await (await openBundle('?transcript=0')).json()) as Record<string, any>;
    expect(legCalls).not.toContain('transcript');
    // `known: true` — the bundle DID answer; `requested: false` says the caller
    // asked for no bytes. Reporting `known: false` here would tell the client
    // the transcript is unknown when it is merely unasked-for.
    expect(body.transcript).toEqual({ known: true, requested: false });
  });

  test('derives held from the queue rows, not from a guess', async () => {
    queueLeg = async () => [
      { state: 'queued', reason: null },
      { state: 'waiting', reason: 'held' },
    ];
    const body = (await (await openBundle()).json()) as Record<string, any>;
    expect(body.queue.held).toBe(true);
    expect(body.queue.prompts).toHaveLength(2);
  });

  test('a waiting row that is not HELD does not hold the queue', async () => {
    queueLeg = async () => [{ state: 'waiting', reason: 'awaiting_approval' }];
    const body = (await (await openBundle()).json()) as Record<string, any>;
    expect(body.queue.held).toBe(false);
  });

  test('one failed leg degrades to known:false and never fails the bundle', async () => {
    turnLeg = async () => {
      throw new Error('turn read exploded');
    };
    const response = await openBundle();
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    // UNKNOWN, not idle: `{ turns: [] }` here would be the exact defect the
    // bundle exists to remove — a default rendered as an answer.
    expect(body.turn).toEqual({ known: false, reason: 'leg_failed' });
    expect(body.turn.turns).toBeUndefined();
    // Everything else still arrives.
    expect(body.queue.known).toBe(true);
    expect(body.transcript.known).toBe(true);
  });

  test('a failed transcript leg is unknown, never an empty thread', async () => {
    transcriptLeg = async () => {
      throw new Error('mirror unavailable');
    };
    const body = (await (await openBundle()).json()) as Record<string, any>;
    expect(body.transcript).toEqual({ known: false, reason: 'leg_failed' });
    expect(body.transcript.messages).toBeUndefined();
  });

  test('a gateway-disabled project reports models unknown, not "no default"', async () => {
    gatewayEnabled = false;
    const body = (await (await openBundle()).json()) as Record<string, any>;
    expect(body.models).toEqual({ known: false, reason: 'llm_gateway_disabled' });
    expect(body.config.llm_gateway_enabled).toBe(false);
    expect(legCalls).not.toContain('models');
  });

  test('falls back to the project default branch when the session pins no base ref', async () => {
    (visibleSession as any).row.baseRef = 'feature/x';
    const body = (await (await openBundle()).json()) as Record<string, any>;
    expect(body.config.base_ref).toBe('feature/x');
  });

  /**
   * The `runtime` leg — the reason a STOPPED session can answer
   * "which agents, which commands, what model" at all.
   */
  describe('the runtime leg', () => {
    test('a fresh projection is served with its cursor, and no refresh is scheduled', async () => {
      const response = await openBundle();
      const body = (await response.json()) as Record<string, any>;
      expect(body.runtime).toMatchObject({
        known: true,
        fresh: true,
        epoch: 'bmtaokkdb0piayh',
        seq: 41,
      });
      // `epoch` + `seq` are exactly what the client hands to
      // `stream?epoch=&since=`, so seeding and streaming cannot disagree about
      // what has already been applied.
      expect(body.runtime.state.agents.value).toEqual([{ name: 'build' }]);
      expect(refreshCalls).toEqual([]);
    });

    test('it is read ONCE, alongside the other legs', async () => {
      await openBundle();
      expect(legCalls.filter((leg) => leg === 'runtime')).toHaveLength(1);
    });

    test('no projection is `known:false` with a reason — never an empty agent list', async () => {
      runtimeLeg = async () => ({ known: false, reason: 'no_projection' });
      const response = await openBundle();
      const body = (await response.json()) as Record<string, any>;
      expect(response.status).toBe(200);
      expect(body.runtime).toEqual({ known: false, reason: 'no_projection' });
      // Nothing that looks like an answer leaked in beside the refusal.
      expect(body.runtime.state).toBeUndefined();
    });

    test('a leg the store could not answer schedules a BACKGROUND refresh for next time', async () => {
      runtimeLeg = async () => ({ known: false, reason: 'stale' });
      await openBundle();
      expect(refreshCalls).toEqual([
        { sessionId: SESSION_ID, projectId: PROJECT_ID, accountId: ACCOUNT_ID, userId: USER_ID },
      ]);
    });

    test('a THROWING runtime leg degrades that leg only, with a stable code', async () => {
      runtimeLeg = async () => {
        throw new Error('relation "session_runtime_projections" does not exist');
      };
      const response = await openBundle();
      const body = (await response.json()) as Record<string, any>;
      expect(response.status).toBe(200);
      expect(body.runtime).toEqual({ known: false, reason: 'leg_failed' });
      // The raw Postgres text must not reach a caller with project `read`.
      expect(JSON.stringify(body)).not.toContain('session_runtime_projections');
      // Every other leg still answered.
      expect(body.turn.known).toBe(true);
      expect(body.queue.known).toBe(true);
      expect(body.transcript.known).toBe(true);
    });

    test('the runtime leg never blocks the response on a sandbox', async () => {
      // The leg is a DB read and the refresh is fire-and-forget, so a bundle for
      // a session whose box is asleep answers on the control plane's clock. A
      // refresh that took a second would show up here as a second of latency.
      runtimeLeg = async () => ({ known: false, reason: 'no_projection' });
      const started = Date.now();
      const response = await openBundle();
      expect(response.status).toBe(200);
      expect(Date.now() - started).toBeLessThan(1_000);
    });
  });
});
