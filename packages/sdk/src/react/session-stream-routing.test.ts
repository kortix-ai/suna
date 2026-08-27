import { describe, expect, test } from 'bun:test';
import type { SessionStreamFrame } from '../core/rest/projects-client/session-stream';
import {
  applyRuntimeStateLeg,
  routeSessionStreamFrame,
  type RuntimeStateLegDeps,
  type SessionStreamSinks,
} from './session-stream-routing';

function sinks(): SessionStreamSinks & {
  runtimeEvents: Array<{ type: string; properties: unknown }>;
  turns: unknown[];
  queues: Array<{ prompts: unknown[]; atMs: number }>;
  legs: unknown[];
  audits: string[];
} {
  const runtimeEvents: Array<{ type: string; properties: unknown }> = [];
  const turns: unknown[] = [];
  const queues: Array<{ prompts: unknown[]; atMs: number }> = [];
  const legs: unknown[] = [];
  const audits: string[] = [];
  return {
    runtimeEvents,
    turns,
    queues,
    legs,
    audits,
    applyRuntimeEvent: (event) => runtimeEvents.push(event as never),
    applyControlTurn: (observation) => turns.push(observation),
    applyControlQueue: (prompts, atMs) => queues.push({ prompts: [...prompts], atMs }),
    applyRuntimeStateLeg: (leg) => legs.push(leg),
    applyControlAudit: (fingerprint) => audits.push(fingerprint),
  };
}

describe('routeSessionStreamFrame', () => {
  test('runtime frames become OpenCode events; connection frames do not', () => {
    const s = sinks();
    routeSessionStreamFrame(
      {
        channel: 'runtime',
        type: 'permission.asked',
        seq: 2,
        epoch: 'ep1',
        payload: { id: 'per_1', sessionID: 'ses_x' },
      } as SessionStreamFrame,
      s,
    );
    routeSessionStreamFrame(
      { channel: 'runtime', type: 'kortix.heartbeat', at: 5 } as SessionStreamFrame,
      s,
    );
    routeSessionStreamFrame(
      { channel: 'stream', type: 'kortix.stream.hello' } as SessionStreamFrame,
      s,
    );
    expect(s.runtimeEvents).toEqual([
      { type: 'permission.asked', properties: { id: 'per_1', sessionID: 'ses_x' } },
    ]);
  });

  test('a known control turn snapshot lands as a stamped observation', () => {
    const s = sinks();
    routeSessionStreamFrame(
      {
        channel: 'control',
        type: 'kortix.control.turn',
        cseq: 1,
        cepoch: 'c1',
        at: 1234,
        payload: { known: true, turns: [{ turn_token: 't1' }], last_ended: { turn_token: 't0' } },
      } as SessionStreamFrame,
      s,
    );
    expect(s.turns).toEqual([
      { turns: [{ turn_token: 't1' }], last_ended: { turn_token: 't0' }, atMs: 1234 },
    ]);
  });

  test('an UNKNOWN control snapshot is never applied — unknown is not idle', () => {
    const s = sinks();
    routeSessionStreamFrame(
      {
        channel: 'control',
        type: 'kortix.control.turn',
        cseq: 1,
        at: 1,
        payload: { known: false, reason: 'read failed' },
      } as SessionStreamFrame,
      s,
    );
    routeSessionStreamFrame(
      {
        channel: 'control',
        type: 'kortix.control.queue',
        cseq: 2,
        at: 1,
        payload: { known: false },
      } as SessionStreamFrame,
      s,
    );
    expect(s.turns).toEqual([]);
    expect(s.queues).toEqual([]);
  });

  test('a known queue snapshot carries its prompts and the server stamp', () => {
    const s = sinks();
    routeSessionStreamFrame(
      {
        channel: 'control',
        type: 'kortix.control.queue',
        cseq: 3,
        at: 777,
        payload: { known: true, prompts: [{ prompt_id: 'pr_1' }], held: false },
      } as SessionStreamFrame,
      s,
    );
    expect(s.queues).toEqual([{ prompts: [{ prompt_id: 'pr_1' }], atMs: 777 }]);
  });

  test('runtime_state control frames hand the whole leg through', () => {
    const s = sinks();
    const leg = { known: true, state: { epoch: 'ep1' } };
    routeSessionStreamFrame(
      {
        channel: 'control',
        type: 'kortix.control.runtime_state',
        cseq: 4,
        at: 1,
        payload: leg,
      } as SessionStreamFrame,
      s,
    );
    expect(s.legs).toEqual([leg]);
  });

  test('a known audit watermark becomes a change fingerprint', () => {
    const s = sinks();
    routeSessionStreamFrame(
      {
        channel: 'control',
        type: 'kortix.control.audit',
        cseq: 6,
        at: 1,
        payload: {
          known: true,
          pending: 2,
          latest_at: '2026-08-27T00:00:00.000Z',
          latest_resolved_at: null,
        },
      } as SessionStreamFrame,
      s,
    );
    expect(s.audits).toEqual([
      JSON.stringify([2, '2026-08-27T00:00:00.000Z', null]),
    ]);
  });

  test('a known-false audit read bumps nothing (it says nothing changed)', () => {
    const s = sinks();
    routeSessionStreamFrame(
      {
        channel: 'control',
        type: 'kortix.control.audit',
        cseq: 7,
        at: 1,
        payload: { known: false },
      } as SessionStreamFrame,
      s,
    );
    expect(s.audits).toEqual([]);
  });

  test('unrecognized control types are ignored, not misapplied', () => {
    const s = sinks();
    routeSessionStreamFrame(
      {
        channel: 'control',
        type: 'kortix.control.mirror',
        cseq: 5,
        at: 1,
        payload: { known: true, present: true },
      } as SessionStreamFrame,
      s,
    );
    expect(s.turns).toEqual([]);
    expect(s.queues).toEqual([]);
    expect(s.legs).toEqual([]);
    expect(s.audits).toEqual([]);
  });
});

// ── applyRuntimeStateLeg ─────────────────────────────────────────────────────

function legDeps(): RuntimeStateLegDeps & {
  statusWrites: Array<{ sessionID: string; status: unknown }>;
  reconciled: unknown[];
  added: unknown[];
  recoveries: string[];
} {
  const statusWrites: Array<{ sessionID: string; status: unknown }> = [];
  const reconciled: unknown[] = [];
  const added: unknown[] = [];
  const recoveries: string[] = [];
  return {
    statusWrites,
    reconciled,
    added,
    recoveries,
    nowMs: 100_000,
    statusSlot: () => ({ hasSlot: false, origin: undefined, stampedAtMs: undefined }),
    applySessionStatus: (sessionID, status) => statusWrites.push({ sessionID, status }),
    reconcileMissingBusy: (statuses) => reconciled.push(statuses),
    hasPendingPermission: () => false,
    hasPendingQuestion: () => false,
    addPermission: (p) => added.push(p),
    requestAskRecovery: (kind) => recoveries.push(kind),
  };
}

const fullLeg = (overrides: Record<string, unknown> = {}) => ({
  known: true,
  state: {
    statuses: { known: true, value: { ses_a: { type: 'busy' } } },
    permissions: {
      known: true,
      value: [{ id: 'per_1', sessionID: 'ses_a', permission: 'bash', patterns: ['rm *'] }],
    },
    questions: { known: true, value: [{ id: 'qst_1', sessionID: 'ses_a' }] },
    ...overrides,
  },
});

describe('applyRuntimeStateLeg', () => {
  test('fills status slots, reconciles absences, seeds permissions, and recovers questions', () => {
    const deps = legDeps();
    applyRuntimeStateLeg(fullLeg(), deps);
    expect(deps.statusWrites).toEqual([{ sessionID: 'ses_a', status: { type: 'busy' } }]);
    expect(deps.reconciled).toEqual([{ ses_a: { type: 'busy' } }]);
    expect(deps.added).toEqual([
      { id: 'per_1', sessionID: 'ses_a', permission: 'bash', patterns: ['rm *'] },
    ]);
    // The projection deliberately trims question bodies, so an unknown open
    // question triggers a full read instead of seeding an unrenderable card.
    expect(deps.recoveries).toEqual(['questions']);
  });

  test('a fresh WIRE slot blocks the status fill; enumeration still reconciles', () => {
    const deps = legDeps();
    deps.statusSlot = () => ({ hasSlot: true, origin: 'wire', stampedAtMs: 99_000 });
    applyRuntimeStateLeg(fullLeg(), deps);
    expect(deps.statusWrites).toEqual([]);
    expect(deps.reconciled.length).toBe(1);
  });

  test('known:false sections apply NOTHING — a failed read is not an empty roster', () => {
    const deps = legDeps();
    applyRuntimeStateLeg(
      fullLeg({
        statuses: { known: false, reason: 'read failed' },
        permissions: { known: false },
        questions: { known: false },
      }),
      deps,
    );
    expect(deps.statusWrites).toEqual([]);
    expect(deps.reconciled).toEqual([]);
    expect(deps.added).toEqual([]);
    expect(deps.recoveries).toEqual([]);
  });

  test('asks already pending are neither re-added nor re-fetched', () => {
    const deps = legDeps();
    deps.hasPendingPermission = () => true;
    deps.hasPendingQuestion = () => true;
    applyRuntimeStateLeg(fullLeg(), deps);
    expect(deps.added).toEqual([]);
    expect(deps.recoveries).toEqual([]);
  });

  test('an unknown leg is a no-op', () => {
    const deps = legDeps();
    applyRuntimeStateLeg({ known: false, reason: 'no_projection' }, deps);
    applyRuntimeStateLeg(null, deps);
    expect(deps.statusWrites).toEqual([]);
    expect(deps.reconciled).toEqual([]);
  });
});
