import { describe, expect, it } from 'vitest';
import {
  attemptsFor,
  classifyFlowError,
  DEFAULT_FLOW_ATTEMPTS,
  DEFAULT_SESSION_RUNTIME_ATTEMPTS,
  DEFAULT_TIMEOUT_ATTEMPTS,
  KE2E_FLOW_TIMEOUT,
  maxAttemptBound,
  readAttemptPolicy,
  type RegisteredFlow,
} from '../src/core/flow';
import { runScheduled, type LaneSchedule } from '../src/core/lanes';
import { markSessionReadinessTimeoutRetryable } from '../src/core/session-runtime-retry';

function flowTimeoutError(id = 'CR-9', ms = 1_200_000): Error {
  const error = new Error(`flow ${id} exceeded ${ms}ms`);
  (error as Record<string, unknown>)[KE2E_FLOW_TIMEOUT] = true;
  return error;
}

describe('flow attempt policy (P1.1)', () => {
  it('defaults to 3 infra attempts, 1 timeout attempt, 2 session-runtime attempts', () => {
    const policy = readAttemptPolicy({});

    expect(policy).toEqual({ infra: 3, timeout: 1, sessionRuntime: 2 });
    expect(DEFAULT_FLOW_ATTEMPTS).toBe(3);
    expect(DEFAULT_TIMEOUT_ATTEMPTS).toBe(1);
    expect(DEFAULT_SESSION_RUNTIME_ATTEMPTS).toBe(2);
  });

  it('reads every budget from its own env knob', () => {
    expect(
      readAttemptPolicy({
        KE2E_FLOW_ATTEMPTS: '5',
        KE2E_TIMEOUT_ATTEMPTS: '2',
        KE2E_SESSION_RUNTIME_ATTEMPTS: '4',
      }),
    ).toEqual({ infra: 5, timeout: 2, sessionRuntime: 4 });
  });

  it('rejects junk and clamps to at least one attempt', () => {
    expect(readAttemptPolicy({ KE2E_FLOW_ATTEMPTS: 'nonsense' }).infra).toBe(3);
    expect(readAttemptPolicy({ KE2E_FLOW_ATTEMPTS: '0' }).infra).toBe(1);
  });

  it('keeps the legacy KE2E_DEFAULT_FLOW_ATTEMPTS as a ceiling over EVERY class', () => {
    // local-profile.ts and preview-stack.ts both pin this to 1 for determinism.
    // If it only fed the infra budget, those runs would silently regain a
    // session-runtime retry they deliberately gave up.
    expect(readAttemptPolicy({ KE2E_DEFAULT_FLOW_ATTEMPTS: '1' })).toEqual({
      infra: 1,
      timeout: 1,
      sessionRuntime: 1,
    });
    expect(readAttemptPolicy({ KE2E_DEFAULT_FLOW_ATTEMPTS: '6' })).toEqual({
      infra: 6,
      timeout: 1,
      sessionRuntime: 2,
    });
  });

  it('lets the explicit knobs win under the legacy ceiling', () => {
    expect(
      readAttemptPolicy({ KE2E_FLOW_ATTEMPTS: '4', KE2E_DEFAULT_FLOW_ATTEMPTS: '2' }).infra,
    ).toBe(2);
  });

  it('does NOT retry a flow-level timeout — it is a hang, not a blip', () => {
    const policy = readAttemptPolicy({});
    const error = flowTimeoutError();

    // The timeout path must never carry the generic infra marker again.
    expect((error as Record<string, unknown>).ke2eRetryable).toBeUndefined();
    expect(classifyFlowError(error, false)).toBe('timeout');
    expect(attemptsFor('timeout', policy)).toBe(1);
  });

  it('re-enables timeout retries only when KE2E_TIMEOUT_ATTEMPTS asks for it', () => {
    const policy = readAttemptPolicy({ KE2E_TIMEOUT_ATTEMPTS: '3' });

    expect(attemptsFor(classifyFlowError(flowTimeoutError(), false), policy)).toBe(3);
  });

  it('caps a session-runtime readiness timeout at 2 attempts, not 3', () => {
    const sessionId = 'session-1';
    const error = markSessionReadinessTimeoutRetryable(
      new Error(`Timed out waiting for session runtime ready for ${sessionId}`),
      sessionId,
    );
    const policy = readAttemptPolicy({});

    expect(classifyFlowError(error, false)).toBe('session-runtime');
    expect(attemptsFor('session-runtime', policy)).toBe(2);
    expect(attemptsFor('infra', policy)).toBe(3);
  });

  it('keeps 3 attempts for a genuine network error or laundered 503', () => {
    const network = Object.assign(new Error('network error GET /v1/projects'), {
      ke2eRetryable: true,
    });

    expect(classifyFlowError(network, false)).toBe('infra');
    expect(attemptsFor('infra', readAttemptPolicy({}))).toBe(3);
  });

  it('never retries an assertion failure or an unmarked error', () => {
    const policy = readAttemptPolicy({});

    expect(classifyFlowError(new Error('status expected 200, received 400'), true)).toBe(
      'assertion',
    );
    expect(classifyFlowError(new Error('undefined is not a function'), false)).toBe('fatal');
    expect(attemptsFor('assertion', policy)).toBe(1);
    expect(attemptsFor('fatal', policy)).toBe(1);
  });

  it('bounds the attempt loop by the largest configured class budget', () => {
    expect(maxAttemptBound({ infra: 3, timeout: 1, sessionRuntime: 2 })).toBe(3);
    expect(maxAttemptBound({ infra: 1, timeout: 1, sessionRuntime: 5 })).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// P1.2 — the serial lane overlaps the parallel lanes; the global lane does not.
// ---------------------------------------------------------------------------

interface Trace {
  id: string;
  startedAt: number;
  endedAt: number;
}

function fakeFlow(id: string): RegisteredFlow {
  return { id, meta: { domain: 'test' }, fn: async () => {} };
}

function overlaps(a: Trace, b: Trace): boolean {
  return a.startedAt < b.endedAt && b.startedAt < a.endedAt;
}

/** Run a schedule of fake flows, recording exact start/end windows. */
async function traceSchedule(schedule: LaneSchedule, durationMs = 20): Promise<Trace[]> {
  const traces: Trace[] = [];
  await runScheduled(schedule, async (flow) => {
    const startedAt = performance.now();
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    const trace = { id: flow.id, startedAt, endedAt: performance.now() };
    traces.push(trace);
    return trace;
  });
  return traces;
}

describe('lane scheduling (P1.2)', () => {
  it('runs serial flows one at a time — never beside each other', async () => {
    const schedule: LaneSchedule = {
      concurrent: [{ flows: [fakeFlow('API-1'), fakeFlow('API-2')], workers: 2 }],
      serial: [fakeFlow('SER-1'), fakeFlow('SER-2'), fakeFlow('SER-3')],
      global: [],
    };

    const traces = await traceSchedule(schedule);
    const serial = traces.filter((t) => t.id.startsWith('SER-'));

    expect(serial).toHaveLength(3);
    for (const a of serial) {
      for (const b of serial) {
        if (a.id !== b.id) expect(overlaps(a, b)).toBe(false);
      }
    }
  });

  it('overlaps the serial lane WITH the parallel lanes instead of appending it', async () => {
    const schedule: LaneSchedule = {
      concurrent: [
        { flows: [fakeFlow('API-1'), fakeFlow('API-2'), fakeFlow('API-3')], workers: 3 },
        { flows: [fakeFlow('SBX-1')], workers: 1 },
      ],
      serial: [fakeFlow('SER-1'), fakeFlow('SER-2')],
      global: [],
    };

    const traces = await traceSchedule(schedule);
    const byId = new Map(traces.map((t) => [t.id, t]));
    const firstSerial = byId.get('SER-1')!;

    // The first serial flow must run at the same time as the parallel lanes,
    // not after them. Before P1.2 it started only once both lanes had drained.
    const parallelIds = ['API-1', 'API-2', 'API-3', 'SBX-1'];
    const overlapping = parallelIds.filter((id) => overlaps(firstSerial, byId.get(id)!));
    expect(overlapping.length).toBeGreaterThan(0);
  });

  it('drains every global flow after everything else, one at a time', async () => {
    const schedule: LaneSchedule = {
      concurrent: [{ flows: [fakeFlow('API-1'), fakeFlow('API-2')], workers: 2 }],
      serial: [fakeFlow('SER-1')],
      global: [fakeFlow('BILL-13'), fakeFlow('ADM-19')],
    };

    const traces = await traceSchedule(schedule);
    const byId = new Map(traces.map((t) => [t.id, t]));
    const globals = ['BILL-13', 'ADM-19'].map((id) => byId.get(id)!);
    const others = ['API-1', 'API-2', 'SER-1'].map((id) => byId.get(id)!);

    // A global flow mutates every account on the deployment (BILL-13/ADM-19) or
    // the shared managed repo (CONN-5): nothing may be in flight beside it.
    for (const g of globals) {
      for (const other of [...others, ...globals]) {
        if (other.id !== g.id) expect(overlaps(g, other)).toBe(false);
      }
      expect(g.startedAt).toBeGreaterThanOrEqual(Math.max(...others.map((o) => o.endedAt)));
    }
  });

  it('returns one result per scheduled flow across every lane', async () => {
    const schedule: LaneSchedule = {
      concurrent: [{ flows: [fakeFlow('API-1')], workers: 2 }, { flows: [fakeFlow('SBX-1')], workers: 1 }],
      serial: [fakeFlow('SER-1')],
      global: [fakeFlow('GLB-1')],
    };

    const results = await runScheduled(schedule, async (flow) => flow.id);

    expect(results.sort()).toEqual(['API-1', 'GLB-1', 'SBX-1', 'SER-1']);
  });

  it('tolerates empty lanes', async () => {
    const results = await runScheduled(
      { concurrent: [{ flows: [], workers: 4 }], serial: [], global: [] },
      async (flow) => flow.id,
    );

    expect(results).toEqual([]);
  });
});
