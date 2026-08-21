/**
 * Drives the real POST /:projectId/sessions/:sessionId/audit/events handler.
 * The sandbox payload is hostile. Canonical attribution must come only from
 * the project_sessions and service_accounts rows selected by the handler.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { auditEvents, serviceAccounts, sessionSandboxes } from '@kortix/db';
import {
  SESSION_EVENT_RATE_LIMITED_ACTION,
  __resetAuditRateGuardForTest,
} from '../../shared/opencode-audit-rate-guard';

const ORIGINAL_ENV = {
  ALLOWED_SANDBOX_PROVIDERS: process.env.ALLOWED_SANDBOX_PROVIDERS,
  FRONTEND_URL: process.env.FRONTEND_URL,
  INTERNAL_KORTIX_ENV: process.env.INTERNAL_KORTIX_ENV,
  SUPABASE_URL: process.env.SUPABASE_URL,
};
process.env.ALLOWED_SANDBOX_PROVIDERS = 'daytona';
process.env.FRONTEND_URL = 'https://app.test.kortix.local';
process.env.INTERNAL_KORTIX_ENV = 'dev';
process.env.SUPABASE_URL = 'https://supabase.test.kortix.local';

const ACCOUNT_ID = 'd7100000-0000-4000-a000-000000000001';
const PROJECT_ID = 'd7200000-0000-4000-a000-000000000001';
const SESSION_ID = 'd7300000-0000-4000-a000-000000000001';
const AGENT_ID = 'd7400000-0000-4000-a000-000000000001';
const HUMAN_ID = 'd7500000-0000-4000-a000-000000000001';

let insertedValues: Array<Record<string, unknown>> = [];

const sandboxScope = {
  sessionId: SESSION_ID,
  opencodeSessionId: 'ses_server_owned',
  agentName: 'trusted-agent',
  createdBy: HUMAN_ID,
};

const identityRows = [{ serviceAccountId: AGENT_ID, agentName: 'trusted-agent' }];

function rowsFor(table: unknown): unknown[] {
  if (table === sessionSandboxes) return [sandboxScope];
  if (table === serviceAccounts) return identityRows;
  return [];
}

mock.module('../../shared/db', () => ({
  hasDatabase: () => true,
  db: {
    select: () => ({
      from: (table: unknown) => {
        const whereResult = () => {
          const rows = rowsFor(table);
          return Object.assign(Promise.resolve(rows), {
            limit: async () => rows.slice(0, 1),
          });
        };
        const query = { where: whereResult };
        return {
          ...query,
          innerJoin: () => query,
        };
      },
    }),
    insert: (table: unknown) => ({
      values: (values: Array<Record<string, unknown>>) => {
        if (table !== auditEvents) throw new Error('unexpected insert table');
        insertedValues = values;
        return {
          onConflictDoNothing: () => ({
            returning: async () => values.map((value) => ({ eventId: value.eventId })),
          }),
        };
      },
    }),
  }, auditDb: {
    select: () => ({
      from: (table: unknown) => {
        const whereResult = () => {
          const rows = rowsFor(table);
          return Object.assign(Promise.resolve(rows), {
            limit: async () => rows.slice(0, 1),
          });
        };
        const query = { where: whereResult };
        return {
          ...query,
          innerJoin: () => query,
        };
      },
    }),
    insert: (table: unknown) => ({
      values: (values: Array<Record<string, unknown>>) => {
        if (table !== auditEvents) throw new Error('unexpected insert table');
        insertedValues = values;
        return {
          onConflictDoNothing: () => ({
            returning: async () => values.map((value) => ({ eventId: value.eventId })),
          }),
        };
      },
    }),
  },
}));

const { projectsApp } = await import('../lib/app');
projectsApp.use('*', async (c, next) => {
  c.set('authType', 'apiKey');
  c.set('apiKeyType', 'sandbox');
  c.set('accountId', ACCOUNT_ID);
  c.set('sandboxId', SESSION_ID);
  await next();
});
await import('./project-audit');

function hostileEvent() {
  return {
    event_id: 'a'.repeat(64),
    source_revision: 'd7600000-0000-4000-a000-000000000001',
    type: 'tool.execute.after',
    occurred_at: '2026-08-08T12:00:00.000Z',
    opencode_session_id: 'ses_forged',
    agent_id: 'forged-agent',
    agent_name: 'forged-agent',
    initiator_actor_type: 'service_account',
    initiator_actor_id: 'd7700000-0000-4000-a000-000000000001',
    correlation_id: 'forged-correlation',
    causation_id: 'forged-causation',
    delegation_depth: 99,
    outcome: 'success',
    phase: 'completed',
    input_summary: { tool: 'bash', status: 'completed' },
    output_summary: { type: 'object' },
    input_sha256: 'b'.repeat(64),
    output_sha256: 'c'.repeat(64),
  };
}

beforeEach(() => {
  insertedValues = [];
});

afterAll(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('POST /:projectId/sessions/:sessionId/audit/events', () => {
  test('cannot promote forged sandbox provenance into canonical audit columns', async () => {
    const response = await projectsApp.request(
      `/${PROJECT_ID}/sessions/${SESSION_ID}/audit/events`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events: [hostileEvent()] }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      accepted: 1,
      inserted: 1,
      duplicates: 0,
      suppressed: 0,
    });
    expect(insertedValues).toHaveLength(1);
    expect(insertedValues[0]).toMatchObject({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      opencodeSessionId: 'ses_server_owned',
      actorType: 'agent',
      agentId: AGENT_ID,
      agentName: 'trusted-agent',
      initiatorActorType: 'human',
      initiatorActorId: HUMAN_ID,
      correlationId: SESSION_ID,
      causationId: null,
      delegationDepth: 0,
      metadata: {
        provenance_trust: 'sandbox_reported',
        reported_provenance: {
          opencode_session_id: 'ses_forged',
          agent_id: 'forged-agent',
          agent_name: 'forged-agent',
          initiator_actor_type: 'service_account',
          initiator_actor_id: 'd7700000-0000-4000-a000-000000000001',
          correlation_id: 'forged-correlation',
          causation_id: 'forged-causation',
          delegation_depth: 99,
        },
      },
    });
  });
});

/**
 * The runaway guard, exercised through the real route rather than the pure
 * function — this is the layer that decides what actually reaches the INSERT.
 */
describe('per-session ingest ceiling', () => {
  const CEILING = 5;

  function deltaEvent(n: number) {
    return {
      event_id: n.toString(16).padStart(64, '0'),
      source_revision: `rev-${n}`,
      type: 'message.part.delta',
      occurred_at: '2026-08-08T12:00:00.000Z',
      outcome: 'success',
      phase: 'completed',
      input_sha256: 'b'.repeat(64),
    };
  }

  async function post(events: unknown[]) {
    const response = await projectsApp.request(
      `/${PROJECT_ID}/sessions/${SESSION_ID}/audit/events`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events }),
      },
    );
    return { status: response.status, body: (await response.json()) as Record<string, number> };
  }

  beforeEach(() => {
    process.env.KORTIX_AUDIT_SESSION_EVENT_CEILING = String(CEILING);
    __resetAuditRateGuardForTest();
  });

  afterAll(() => {
    delete process.env.KORTIX_AUDIT_SESSION_EVENT_CEILING;
    __resetAuditRateGuardForTest();
  });

  test('persists every delta while the session stays under the ceiling', async () => {
    const { status, body } = await post([deltaEvent(1), deltaEvent(2), deltaEvent(3)]);

    expect(status).toBe(200);
    expect(body).toEqual({ accepted: 3, inserted: 3, duplicates: 0, suppressed: 0 });
    expect(insertedValues).toHaveLength(3);
  });

  test('stops persisting deltas over the ceiling and records one notice', async () => {
    const { status, body } = await post(
      Array.from({ length: 12 }, (_, i) => deltaEvent(i + 1)),
    );

    expect(status).toBe(200);
    expect(body.accepted).toBe(12);
    expect(body.suppressed).toBe(12 - CEILING);

    // 5 deltas + 1 rate-limited notice reach the INSERT; the other 7 never do.
    expect(insertedValues).toHaveLength(CEILING + 1);
    const notices = insertedValues.filter(
      (value) => value.action === SESSION_EVENT_RATE_LIMITED_ACTION,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      actorType: 'system',
      outcome: 'denied',
    });
    expect(
      insertedValues.filter((value) => value.action === 'opencode.message.part.delta'),
    ).toHaveLength(CEILING);
  });

  test('a runaway session never blocks the request or loses lifecycle events', async () => {
    await post(Array.from({ length: 12 }, (_, i) => deltaEvent(i + 1)));

    const lifecycle = {
      ...deltaEvent(99),
      event_id: 'f'.repeat(64),
      type: 'session.idle',
    };
    const { status, body } = await post([lifecycle]);

    expect(status).toBe(200);
    expect(body.suppressed).toBe(0);
    expect(insertedValues).toHaveLength(1);
    expect(insertedValues[0]).toMatchObject({ action: 'opencode.session.idle' });
  });
});
