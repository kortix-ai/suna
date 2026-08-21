// The monitor observer — the drain that turns a logged event into a fire.
//
// `project_monitor_events` IS the fire queue (spec D2), so this drain is the
// only thing between an appended line and an agent turn. These pin what it
// must refuse to fire (flag off, paused project, disabled or undeclared
// monitor, filtered line) and what it must never let a template author
// suppress (lifecycle events).
//
// Mocks `../projects/lib/triggers` (the fire seam), `../shared/db`, and
// `../feature-flags/registry` via `mock.module` — process-global in bun:test,
// so this file runs under the suite's `--isolate`.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { projectMonitorEvents, projectTriggerRuntime, projects } from '@kortix/db';
import { MONITOR_PROMPT_PREAMBLE } from '../projects/lib/monitor-events';

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const EPOCH = 'epoch-1';
const EMITTED = new Date('2026-08-12T10:00:00.000Z');

let flagEnabled = true;
let paused = false;
let projectRows: Array<Record<string, unknown>> = [];
let runtimeRows: Array<Record<string, unknown>> = [];
let claimCandidates: Array<Record<string, unknown>> = [];
let fireCalls: Array<Record<string, unknown>> = [];
let fireResult: Record<string, unknown> = { status: 'fired', sessionId: 'sess-1' };
let fireError: Error | null = null;
let eventUpdates: Array<Record<string, unknown>> = [];
let runtimeUpdates: Array<Record<string, unknown>> = [];

function thenableUpdate(table: unknown, patch: Record<string, unknown>) {
  const pending: any = Promise.resolve(undefined).then(() => {
    if (table === projectMonitorEvents) eventUpdates.push(patch);
    if (table === projectTriggerRuntime) runtimeUpdates.push(patch);
  });
  // The claim path is `update().set().where().returning()`; the mark paths
  // await the same `where()` directly.
  pending.returning = async () => {
    if (table === projectMonitorEvents) eventUpdates.push(patch);
    return claimCandidates.map((row) => ({ ...row, attempts: Number(row.attempts) + 1 }));
  };
  return pending;
}

mock.module('../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: (_fields?: unknown) => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === projects) return { limit: async () => projectRows };
          if (table === projectTriggerRuntime) return { limit: async () => runtimeRows };
          if (table === projectMonitorEvents) {
            return { orderBy: () => ({ limit: async () => claimCandidates }) };
          }
          throw new Error('unexpected select table');
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({ where: () => thenableUpdate(table, patch) }),
    }),
  }, auditDb: {
    select: (_fields?: unknown) => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === projects) return { limit: async () => projectRows };
          if (table === projectTriggerRuntime) return { limit: async () => runtimeRows };
          if (table === projectMonitorEvents) {
            return { orderBy: () => ({ limit: async () => claimCandidates }) };
          }
          throw new Error('unexpected select table');
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({ where: () => thenableUpdate(table, patch) }),
    }),
  },
}));

mock.module('../feature-flags/registry', () => ({
  resolveFeatureFlag: (_metadata: unknown, key: string) =>
    key === 'monitors' ? flagEnabled : false,
}));

mock.module('../projects/lib/triggers', () => ({
  triggersPausedForProject: () => paused,
  fireGitTrigger: async (input: Record<string, unknown>) => {
    fireCalls.push(input);
    if (fireError) throw fireError;
    return fireResult;
  },
}));

const { drainMonitorEvents, processMonitorEvent } = await import(
  '../projects/lib/monitor-observer'
);

const SPEC = {
  slug: 'checkout',
  name: 'Checkout errors',
  type: 'monitor',
  agent: 'oncall',
  model: null,
  enabled: true,
  promptTemplate: 'Checkout monitor emitted: {{ line.message }}',
  run: './monitors/checkout.ts',
  monitorMode: 'stream',
  sessionMode: 'reuse',
  pinnedSessionId: null,
  sessionKey: null,
  filter: null,
};

function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    eventId: 'event-1',
    projectId: PROJECT_ID,
    slug: 'checkout',
    boxEpoch: EPOCH,
    seq: 812,
    kind: 'event',
    line: { message: 'card declined', severity: 'error' },
    emittedAt: EMITTED,
    ingestedAt: EMITTED,
    status: 'pending',
    attempts: 1,
    sessionId: null,
    lastError: null,
    firedAt: null,
    ...overrides,
  } as never;
}

const NOW = new Date('2026-08-12T10:00:05.000Z');

describe('processMonitorEvent', () => {
  beforeEach(() => {
    flagEnabled = true;
    paused = false;
    projectRows = [{ projectId: PROJECT_ID, accountId: 'acct-1', status: 'active', metadata: {} }];
    runtimeRows = [{ enabled: true, triggerType: 'monitor', scheduleSpec: SPEC }];
    claimCandidates = [];
    fireCalls = [];
    fireResult = { status: 'fired', sessionId: 'sess-1' };
    fireError = null;
    eventUpdates = [];
    runtimeUpdates = [];
  });

  test('fires the trigger with the documented payload, prompt, and idempotency key', async () => {
    expect(await processMonitorEvent(eventRow(), NOW)).toBe('fired');

    expect(fireCalls).toHaveLength(1);
    expect(fireCalls[0]).toMatchObject({
      source: 'monitor',
      idempotencyKey: `trigger:monitor:${PROJECT_ID}:checkout:${EPOCH}:812`,
      payload: {
        line: { message: 'card declined', severity: 'error' },
        monitor: {
          slug: 'checkout',
          seq: 812,
          emitted_at: EMITTED.toISOString(),
          kind: 'event',
        },
        trigger: { slug: 'checkout', type: 'monitor', kind: 'git' },
      },
    });
    // The provenance preamble is server-side: a template author must not have
    // to remember that the agent is reading machine output.
    expect(fireCalls[0]!.renderedPrompt).toBe(
      `${MONITOR_PROMPT_PREAMBLE}Checkout monitor emitted: card declined`,
    );
    expect(eventUpdates.some((u) => u.status === 'fired' && u.sessionId === 'sess-1')).toBe(true);
    // The runtime row records that this monitor is alive.
    expect(runtimeUpdates[0]).toMatchObject({ lastEventAt: EMITTED });
  });

  test('a queued fire still counts as fired', async () => {
    fireResult = { status: 'queued', sessionId: 'sess-2' };
    expect(await processMonitorEvent(eventRow(), NOW)).toBe('fired');
  });

  // Silence must not be filterable by accident, and a dead monitor has to
  // produce a legible turn even when the template only formats healthy lines.
  test('a lifecycle event bypasses the filter and uses the platform prompt', async () => {
    runtimeRows = [
      {
        enabled: true,
        triggerType: 'monitor',
        scheduleSpec: { ...SPEC, filter: { 'line.severity': 'error' } },
      },
    ];

    const result = await processMonitorEvent(
      eventRow({ kind: 'lifecycle', line: { event: 'exited', detail: 'exit code 137' } }),
      NOW,
    );

    expect(result).toBe('fired');
    const prompt = String(fireCalls[0]!.renderedPrompt);
    expect(prompt.startsWith(MONITOR_PROMPT_PREAMBLE)).toBe(true);
    expect(prompt).toContain('exited');
    expect(prompt).toContain('Checkout errors');
    expect(prompt).toContain('exit code 137');
    // NOT the author's template.
    expect(prompt).not.toContain('Checkout monitor emitted');
  });

  test('an event that fails the filter is skipped without firing', async () => {
    runtimeRows = [
      {
        enabled: true,
        triggerType: 'monitor',
        scheduleSpec: { ...SPEC, filter: { 'line.severity': 'fatal' } },
      },
    ];

    expect(await processMonitorEvent(eventRow(), NOW)).toBe('skipped');
    expect(fireCalls).toHaveLength(0);
    expect(eventUpdates[0]).toMatchObject({ status: 'skipped', lastError: 'filter did not match' });
  });

  // The behavioral half of the flag: turning `monitors` off stops firing even
  // if the ingest route were bypassed.
  test('a flag-off project never fires', async () => {
    flagEnabled = false;

    expect(await processMonitorEvent(eventRow(), NOW)).toBe('skipped');
    expect(fireCalls).toHaveLength(0);
    expect(String(eventUpdates[0]!.lastError)).toContain('not enabled');
  });

  test('a paused project never fires', async () => {
    paused = true;

    expect(await processMonitorEvent(eventRow(), NOW)).toBe('skipped');
    expect(fireCalls).toHaveLength(0);
    expect(eventUpdates[0]).toMatchObject({ lastError: 'project triggers are paused' });
  });

  test('an inactive or missing project never fires', async () => {
    projectRows = [];
    expect(await processMonitorEvent(eventRow(), NOW)).toBe('skipped');
    projectRows = [{ projectId: PROJECT_ID, status: 'archived', metadata: {} }];
    expect(await processMonitorEvent(eventRow(), NOW)).toBe('skipped');
    expect(fireCalls).toHaveLength(0);
  });

  test('an undeclared or disabled monitor never fires', async () => {
    runtimeRows = [];
    expect(await processMonitorEvent(eventRow(), NOW)).toBe('skipped');
    expect(String(eventUpdates[0]!.lastError)).toContain('not declared');

    eventUpdates = [];
    runtimeRows = [{ enabled: false, triggerType: 'monitor', scheduleSpec: SPEC }];
    expect(await processMonitorEvent(eventRow(), NOW)).toBe('skipped');
    expect(eventUpdates[0]).toMatchObject({ lastError: 'monitor is disabled' });

    // A cron row under the same slug must never be driven by the monitor path.
    eventUpdates = [];
    runtimeRows = [{ enabled: true, triggerType: 'cron', scheduleSpec: SPEC }];
    expect(await processMonitorEvent(eventRow(), NOW)).toBe('skipped');
    expect(fireCalls).toHaveLength(0);
  });

  test('a failed fire stays pending until the attempt ceiling, then dead-letters', async () => {
    fireResult = { status: 'failed', error: 'sandbox unavailable' };

    expect(await processMonitorEvent(eventRow({ attempts: 1 }), NOW)).toBe('failed');
    expect(eventUpdates[0]).toMatchObject({ status: 'pending', lastError: 'sandbox unavailable' });

    eventUpdates = [];
    expect(await processMonitorEvent(eventRow({ attempts: 5 }), NOW)).toBe('failed');
    expect(eventUpdates[0]).toMatchObject({ status: 'failed' });
  });

  test('a thrown fire is recorded, not swallowed', async () => {
    fireError = new Error('boom');

    expect(await processMonitorEvent(eventRow(), NOW)).toBe('failed');
    expect(eventUpdates[0]).toMatchObject({ lastError: 'boom' });
  });
});

describe('drainMonitorEvents', () => {
  beforeEach(() => {
    flagEnabled = true;
    paused = false;
    projectRows = [{ projectId: PROJECT_ID, accountId: 'acct-1', status: 'active', metadata: {} }];
    runtimeRows = [{ enabled: true, triggerType: 'monitor', scheduleSpec: SPEC }];
    fireCalls = [];
    fireResult = { status: 'fired', sessionId: 'sess-1' };
    fireError = null;
    eventUpdates = [];
    runtimeUpdates = [];
  });

  test('claims pending events and reports the outcome counts', async () => {
    claimCandidates = [eventRow(), eventRow({ eventId: 'event-2', seq: 813 })];

    const result = await drainMonitorEvents(NOW);

    expect(result).toEqual({ fired: 2, skipped: 0, failed: 0 });
    expect(fireCalls).toHaveLength(2);
  });

  test('an empty queue is a no-op', async () => {
    claimCandidates = [];
    expect(await drainMonitorEvents(NOW)).toEqual({ fired: 0, skipped: 0, failed: 0 });
    expect(fireCalls).toHaveLength(0);
  });
});
