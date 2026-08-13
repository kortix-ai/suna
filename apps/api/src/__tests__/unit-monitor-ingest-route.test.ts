// POST /v1/projects/:projectId/monitors/ingest — the monitor event intake.
//
// The route is the trust boundary for the whole feature: it is the only way a
// row reaches `project_monitor_events`, and every row it accepts eventually
// wakes an agent. So these pin the four things that must never regress —
// sandbox-token-only auth against the project's OWN monitor box, the feature
// flag, ingest dedup, and the platform-enforced rate bound.
//
// Mocks `../shared/db` and `../feature-flags/registry` via `mock.module`
// (process-global in bun:test — the suite runs with `--isolate`).
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  projectMonitorBoxes,
  projectMonitorEvents,
  projectTriggerRuntime,
  projects,
} from '@kortix/db';
import { Hono } from 'hono';
import * as realRegistry from '../feature-flags/registry';
import {
  MONITOR_LINE_MAX_BYTES,
  MONITOR_RATE_SUSTAINED_PER_HOUR,
} from '../projects/lib/monitor-events';

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';
const SANDBOX_ID = 'monitor-box-sandbox-1';
const EPOCH = 'epoch-1';
const EMITTED = '2026-08-12T10:00:00.000Z';

let flagEnabled = true;
let authType: string | undefined = 'apiKey';
let apiKeyType: string | undefined = 'sandbox';
let accountId: string | undefined = ACCOUNT_ID;
let sandboxId: string | undefined = SANDBOX_ID;
let boxRows: Array<Record<string, unknown>> = [];
let projectRows: Array<Record<string, unknown>> = [];
let runtimeRow: Record<string, unknown> | null = null;
let rateWindow = { hourCount: 0, burstCount: 0 };
let storedEvents: Array<Record<string, unknown>> = [];
let runtimeUpdates: Array<Record<string, unknown>> = [];

function box(overrides: Record<string, unknown> = {}) {
  return { boxId: 'box-1', projectId: PROJECT_ID, boxEpoch: EPOCH, ...overrides };
}

mock.module('../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: (_fields?: unknown) => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === projectMonitorBoxes) return { limit: async () => boxRows };
          if (table === projects) return { limit: async () => projectRows };
          if (table === projectTriggerRuntime) {
            return { limit: async () => (runtimeRow ? [runtimeRow] : []) };
          }
          // countMonitorRateWindow awaits the query directly (no .limit()).
          if (table === projectMonitorEvents) return Promise.resolve([rateWindow]);
          throw new Error('unexpected select table');
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (row: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (table !== projectMonitorEvents) throw new Error('unexpected insert table');
            // The real dedup index: (project_id, slug, box_epoch, seq).
            const duplicate = storedEvents.some(
              (stored) =>
                stored.projectId === row.projectId &&
                stored.slug === row.slug &&
                stored.boxEpoch === row.boxEpoch &&
                stored.seq === row.seq,
            );
            if (duplicate) return [];
            storedEvents.push(row);
            return [{ eventId: `event-${storedEvents.length}` }];
          },
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: async () => {
          if (table !== projectTriggerRuntime) throw new Error('unexpected update table');
          runtimeUpdates.push(patch);
          if (runtimeRow) Object.assign(runtimeRow, patch);
        },
      }),
    }),
  },
}));

mock.module('../feature-flags/registry', () => ({
  ...realRegistry,
  resolveFeatureFlag: (_metadata: unknown, key: string) =>
    key === 'monitors' ? flagEnabled : false,
}));

const { projectsApp } = await import('../projects/lib/app');
await import('../projects/routes/monitors');

function buildApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (authType) c.set('authType' as never, authType as never);
    if (apiKeyType) c.set('apiKeyType' as never, apiKeyType as never);
    if (accountId) c.set('accountId' as never, accountId as never);
    if (sandboxId) c.set('sandboxId' as never, sandboxId as never);
    await next();
  });
  app.route('/v1/projects', projectsApp);
  return app;
}

function ingest(body: unknown, projectId: string = PROJECT_ID) {
  return buildApp().request(`/v1/projects/${projectId}/monitors/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    slug: 'checkout',
    seq: 1,
    kind: 'event',
    line: { severity: 'error' },
    emitted_at: EMITTED,
    ...overrides,
  };
}

describe('POST /v1/projects/:projectId/monitors/ingest', () => {
  beforeEach(() => {
    flagEnabled = true;
    authType = 'apiKey';
    apiKeyType = 'sandbox';
    accountId = ACCOUNT_ID;
    sandboxId = SANDBOX_ID;
    boxRows = [box()];
    projectRows = [{ projectId: PROJECT_ID, metadata: {} }];
    runtimeRow = { suppressedUntil: null, suppressionCount: 0 };
    rateWindow = { hourCount: 0, burstCount: 0 };
    storedEvents = [];
    runtimeUpdates = [];
  });

  test('accepts a batch from the project monitor box', async () => {
    const response = await ingest({ box_epoch: EPOCH, events: [event(), event({ seq: 2 })] });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: 2, deduped: 0, suppressed: 0 });
    expect(storedEvents).toHaveLength(2);
    expect(storedEvents[0]).toMatchObject({
      projectId: PROJECT_ID,
      slug: 'checkout',
      boxEpoch: EPOCH,
      seq: 1,
      kind: 'event',
      status: 'pending',
    });
  });

  // A human PAT has no business writing into the event log: the log's whole
  // value is that its rows came from the box.
  test('rejects a non-sandbox token', async () => {
    authType = 'supabase';
    apiKeyType = undefined;

    const response = await ingest({ box_epoch: EPOCH, events: [event()] });

    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toMatch(/sandbox token/);
    expect(storedEvents).toHaveLength(0);
  });

  test('rejects a sandbox token with no account or sandbox id', async () => {
    sandboxId = undefined;
    expect((await ingest({ box_epoch: EPOCH, events: [event()] })).status).toBe(403);
  });

  // A monitor box has no `session_sandboxes` row, so the token is scoped
  // against `project_monitor_boxes` — project AND account AND live status.
  test("rejects a sandbox token that is not this project's monitor box", async () => {
    boxRows = [];

    const response = await ingest({ box_epoch: EPOCH, events: [event()] });

    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toMatch(
      /not scoped to this project monitor box/,
    );
    expect(storedEvents).toHaveLength(0);
  });

  test('404s when the project does not exist', async () => {
    projectRows = [];
    expect((await ingest({ box_epoch: EPOCH, events: [event()] })).status).toBe(404);
  });

  test('rejects with feature_disabled when the monitors flag is off', async () => {
    flagEnabled = false;

    const response = await ingest({ box_epoch: EPOCH, events: [event()] });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'feature_disabled', feature: 'monitors' });
    expect(storedEvents).toHaveLength(0);
  });

  // `seq` restarts per epoch, so a resurrected old runner would replay
  // sequence numbers the current epoch is about to use.
  test('rejects a stale box_epoch', async () => {
    const response = await ingest({ box_epoch: 'epoch-0', events: [event()] });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'stale_box_epoch' });
    expect(storedEvents).toHaveLength(0);
  });

  test('rejects a malformed batch with 400', async () => {
    expect((await ingest({ box_epoch: EPOCH, events: [] })).status).toBe(400);
    expect((await ingest({ events: [event()] })).status).toBe(400);
    expect((await ingest({ box_epoch: EPOCH, events: [event({ kind: 'stdout' })] })).status).toBe(
      400,
    );
  });

  // At-least-once delivery is the runner's contract, so the same (epoch, seq)
  // arriving twice must cost one no-op write, not a duplicate agent turn.
  test('the same epoch+seq twice stores exactly one row', async () => {
    await ingest({ box_epoch: EPOCH, events: [event()] });
    const second = await ingest({ box_epoch: EPOCH, events: [event()] });

    expect(await second.json()).toEqual({ accepted: 0, deduped: 1, suppressed: 0 });
    expect(storedEvents).toHaveLength(1);
  });

  test('an oversize line is truncated with a marker, not rejected', async () => {
    const response = await ingest({
      box_epoch: EPOCH,
      events: [event({ line: { raw: 'x'.repeat(MONITOR_LINE_MAX_BYTES * 2) } })],
    });

    expect(response.status).toBe(202);
    const line = storedEvents[0]!.line as Record<string, unknown>;
    expect(line.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(line), 'utf8')).toBeLessThanOrEqual(
      MONITOR_LINE_MAX_BYTES,
    );
  });

  test('over-limit events are stored suppressed and open a suppression window', async () => {
    rateWindow = { hourCount: MONITOR_RATE_SUSTAINED_PER_HOUR, burstCount: 0 };

    const response = await ingest({ box_epoch: EPOCH, events: [event()] });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: 0, deduped: 0, suppressed: 1 });
    // Stored, never dropped — the log is the contract.
    expect(storedEvents[0]).toMatchObject({ status: 'suppressed' });
    expect(runtimeUpdates[0]).toMatchObject({ suppressionCount: 1 });
    expect(runtimeUpdates[0]!.suppressedUntil).toBeInstanceOf(Date);
    expect(runtimeUpdates[0]).not.toHaveProperty('enabled');
  });

  test('the third suppression in 24h disables the monitor with a last_error', async () => {
    rateWindow = { hourCount: MONITOR_RATE_SUSTAINED_PER_HOUR, burstCount: 0 };
    // Two episodes already closed inside the 24h horizon.
    runtimeRow = { suppressedUntil: new Date(Date.now() - 60 * 60_000), suppressionCount: 2 };

    await ingest({ box_epoch: EPOCH, events: [event()] });

    expect(runtimeUpdates[0]).toMatchObject({ suppressionCount: 3, enabled: false });
    expect(String(runtimeUpdates[0]!.lastError)).toContain('auto-disabled');
  });

  test('a monitor already inside its suppression window keeps suppressing', async () => {
    runtimeRow = { suppressedUntil: new Date(Date.now() + 60_000), suppressionCount: 1 };

    const response = await ingest({ box_epoch: EPOCH, events: [event()] });

    expect(await response.json()).toEqual({ accepted: 0, deduped: 0, suppressed: 1 });
    expect(storedEvents[0]).toMatchObject({ status: 'suppressed' });
    // Same episode — no second count, no auto-disable creep.
    expect(runtimeUpdates).toHaveLength(0);
  });
});
