// The monitor-box reconciler's decision matrix.
//
// The reconciler converges desired state on every maintenance tick (spec D5),
// so its decisions ARE the feature's lifecycle: get one wrong and a project
// either pays for a box nobody asked for or silently stops being watched.
// These run the real reconcile loop against an in-memory store — no DB mock,
// because ./monitor-box-core.ts keeps every decision pure and the DB half is a
// thin executor of what these return.
//
// Spec: docs/specs/2026-08-12-monitors.md.

import { describe, expect, test } from 'bun:test';
import {
  MONITOR_CREATES_PER_PASS,
  MONITOR_DEFAULT_MONTHLY_BUDGET_USD,
  MONITOR_MAX_ENABLED,
  type MonitorBoxSnapshot,
  type MonitorBoxStore,
  type MonitorCatalogRow,
  type MonitorProjectSnapshot,
  buildMonitorEnvPayload,
  decideMonitorBox,
  intersectMonitorSecretGrants,
  monitorManifestRevision,
  monitorMonthlyBudgetUsd,
  platformMonitorEpoch,
  reconcileMonitorBoxesWithStore,
  selectEnabledMonitors,
} from '../projects/lib/monitor-box-core';

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';

function monitor(slug: string, over: Partial<MonitorCatalogRow> = {}): MonitorCatalogRow {
  return {
    slug,
    enabled: true,
    scheduleRevision: `rev-${slug}`,
    spec: { run: `./${slug}.ts`, monitorMode: 'stream', intervalSeconds: null, expectEventWithinSeconds: null },
    ...over,
  };
}

function box(over: Partial<MonitorBoxSnapshot> = {}): MonitorBoxSnapshot {
  return { boxId: 'box-1', status: 'running', manifestRevision: 'rev', externalId: 'sbx_1', ...over };
}

function project(over: Partial<MonitorProjectSnapshot> = {}): MonitorProjectSnapshot {
  return {
    projectId: PROJECT_ID,
    accountId: ACCOUNT_ID,
    active: true,
    flagEnabled: true,
    monitors: [monitor('alpha')],
    box: null,
    ...over,
  };
}

interface RecordingStore extends MonitorBoxStore {
  calls: string[];
  lifecycle: Array<{ slug: string; epoch: string; line: Record<string, unknown> }>;
  disabled: string[];
}

function recordingStore(
  projects: MonitorProjectSnapshot[],
  opts: { budgetExceeded?: boolean } = {},
): RecordingStore {
  const calls: string[] = [];
  const lifecycle: RecordingStore['lifecycle'] = [];
  const disabled: string[] = [];
  return {
    calls,
    lifecycle,
    disabled,
    async listProjects() {
      return projects;
    },
    async disableMonitor(_projectId, slug) {
      disabled.push(slug);
      calls.push(`disable:${slug}`);
    },
    async budgetExceeded() {
      calls.push('budget');
      return opts.budgetExceeded ?? false;
    },
    async createBox(_project, monitors, revision) {
      calls.push(`create:${monitors.map((m) => m.slug).join(',')}@${revision}`);
    },
    async stopBox(_project, target, reason) {
      calls.push(`stop:${target.boxId}:${reason}`);
    },
    async observeBox(_project, target) {
      calls.push(`observe:${target.boxId}`);
    },
    async appendLifecycleEvent(_project, slug, epoch, line) {
      lifecycle.push({ slug, epoch, line });
      calls.push(`lifecycle:${slug}:${String(line.event)}`);
    },
  };
}

describe('decideMonitorBox', () => {
  const base = {
    projectActive: true,
    flagEnabled: true,
    enabledMonitors: 1,
    desiredRevision: 'rev',
    budgetExceeded: false,
    box: null as MonitorBoxSnapshot | null,
  };

  test('flag on + monitors + no box ⇒ create', () => {
    expect(decideMonitorBox(base).kind).toBe('create');
  });

  test('flag off ⇒ stop a live box, no-op without one', () => {
    expect(decideMonitorBox({ ...base, flagEnabled: false, box: box() })).toEqual({
      kind: 'stop',
      reason: 'monitors flag is off',
    });
    expect(decideMonitorBox({ ...base, flagEnabled: false }).kind).toBe('none');
  });

  test('zero enabled monitors ⇒ stop a live box', () => {
    expect(decideMonitorBox({ ...base, enabledMonitors: 0, box: box() })).toEqual({
      kind: 'stop',
      reason: 'no enabled monitors',
    });
  });

  test('an inactive project never keeps a box', () => {
    expect(decideMonitorBox({ ...base, projectActive: false, box: box() }).kind).toBe('stop');
  });

  test('budget exceeded stops the box and blocks recreation', () => {
    expect(decideMonitorBox({ ...base, budgetExceeded: true, box: box() })).toEqual({
      kind: 'stop',
      reason: 'monthly monitor compute budget exceeded',
    });
    // The gate must hold with NO box too, or the next tick simply rebuilds it.
    expect(decideMonitorBox({ ...base, budgetExceeded: true }).kind).toBe('none');
  });

  test('the "should a box exist" question is answered before "is it correct"', () => {
    // Flag off AND drifted: the teardown wins, not the restart.
    expect(
      decideMonitorBox({
        ...base,
        flagEnabled: false,
        box: box({ manifestRevision: 'stale' }),
      }).kind,
    ).toBe('stop');
  });

  test('manifest revision drift ⇒ restart', () => {
    expect(decideMonitorBox({ ...base, box: box({ manifestRevision: 'stale' }) })).toEqual({
      kind: 'restart',
      reason: 'manifest revision drift',
    });
  });

  test('a matching box ⇒ observe (the billing-liveness stamp)', () => {
    expect(decideMonitorBox({ ...base, box: box() }).kind).toBe('observe');
  });

  test('an errored box or one with no provider id ⇒ restart', () => {
    expect(decideMonitorBox({ ...base, box: box({ status: 'error' }) }).kind).toBe('restart');
    expect(decideMonitorBox({ ...base, box: box({ externalId: null }) }).kind).toBe('restart');
  });
});

describe('selectEnabledMonitors', () => {
  test('caps at 10, in slug order, and reports the overflow', () => {
    const rows = Array.from({ length: 13 }, (_, index) =>
      monitor(`m${String(index).padStart(2, '0')}`),
    );
    const { selected, overCap } = selectEnabledMonitors(rows.slice().reverse());
    expect(selected).toHaveLength(MONITOR_MAX_ENABLED);
    expect(selected.map((row) => row.slug)).toEqual([
      'm00', 'm01', 'm02', 'm03', 'm04', 'm05', 'm06', 'm07', 'm08', 'm09',
    ]);
    expect(overCap.map((row) => row.slug)).toEqual(['m10', 'm11', 'm12']);
  });

  test('the selection is order-independent — the same ten every tick', () => {
    const rows = Array.from({ length: 12 }, (_, index) => monitor(`m${index}`));
    const forward = selectEnabledMonitors(rows).selected.map((row) => row.slug);
    const shuffled = selectEnabledMonitors([...rows].reverse()).selected.map((row) => row.slug);
    expect(shuffled).toEqual(forward);
  });

  test('disabled monitors and monitors with no run/mode are excluded', () => {
    const { selected } = selectEnabledMonitors([
      monitor('a'),
      monitor('b', { enabled: false }),
      monitor('c', { spec: { run: null, monitorMode: 'stream' } }),
      monitor('d', { spec: null }),
    ]);
    expect(selected.map((row) => row.slug)).toEqual(['a']);
  });
});

describe('monitorManifestRevision', () => {
  test('is stable under ordering and empty for no monitors', () => {
    const rows = [monitor('a'), monitor('b')];
    expect(monitorManifestRevision(rows)).toBe(monitorManifestRevision([...rows].reverse()));
    expect(monitorManifestRevision([])).toBe('');
  });

  test('changes when any monitor’s own schedule revision changes', () => {
    const before = monitorManifestRevision([monitor('a'), monitor('b')]);
    const after = monitorManifestRevision([
      monitor('a'),
      monitor('b', { scheduleRevision: 'rev-b2' }),
    ]);
    expect(after).not.toBe(before);
  });

  test('changes when a monitor is added or removed', () => {
    expect(monitorManifestRevision([monitor('a')])).not.toBe(
      monitorManifestRevision([monitor('a'), monitor('b')]),
    );
  });
});

describe('buildMonitorEnvPayload', () => {
  test('emits exactly what the daemon reads, with poll-only fields omitted', () => {
    const payload = JSON.parse(
      buildMonitorEnvPayload([
        monitor('stream-one', { spec: { run: './s.ts', monitorMode: 'stream', expectEventWithinSeconds: 300 } }),
        monitor('poll-one', { spec: { run: './p.ts', monitorMode: 'poll', intervalSeconds: 60 } }),
      ]),
    );
    expect(payload).toEqual([
      { slug: 'stream-one', run: './s.ts', mode: 'stream', expect_event_within_seconds: 300 },
      { slug: 'poll-one', run: './p.ts', mode: 'poll', interval_seconds: 60 },
    ]);
  });
});

describe('monitorMonthlyBudgetUsd', () => {
  test('defaults, clamps, and never reads a malformed value as unlimited', () => {
    expect(monitorMonthlyBudgetUsd(null)).toBe(MONITOR_DEFAULT_MONTHLY_BUDGET_USD);
    expect(monitorMonthlyBudgetUsd({ monitors: { monthly_budget_usd: 120 } })).toBe(120);
    expect(monitorMonthlyBudgetUsd({ monitors: { monthly_budget_usd: 99_999 } })).toBe(1000);
    expect(monitorMonthlyBudgetUsd({ monitors: { monthly_budget_usd: -1 } })).toBe(
      MONITOR_DEFAULT_MONTHLY_BUDGET_USD,
    );
    expect(monitorMonthlyBudgetUsd({ monitors: { monthly_budget_usd: 'lots' } })).toBe(
      MONITOR_DEFAULT_MONTHLY_BUDGET_USD,
    );
    // 0 is a real value — it means "no monitor compute at all".
    expect(monitorMonthlyBudgetUsd({ monitors: { monthly_budget_usd: 0 } })).toBe(0);
  });
});

describe('platformMonitorEpoch', () => {
  test('is per-month, so a recurring platform notice dedups to one per month', () => {
    expect(platformMonitorEpoch('budget', new Date('2026-08-12T10:00:00Z'))).toBe(
      'platform:budget:2026-08',
    );
    expect(platformMonitorEpoch('budget', new Date('2026-08-30T23:00:00Z'))).toBe(
      'platform:budget:2026-08',
    );
    expect(platformMonitorEpoch('budget', new Date('2026-09-01T00:00:00Z'))).toBe(
      'platform:budget:2026-09',
    );
  });
});

describe('reconcileMonitorBoxesWithStore', () => {
  test('provisions a box for a flag-on project with monitors', async () => {
    const store = recordingStore([project()]);
    const result = await reconcileMonitorBoxesWithStore(store);
    expect(result.created).toBe(1);
    expect(store.calls).toEqual(['budget', `create:alpha@${monitorManifestRevision([monitor('alpha')])}`]);
  });

  test('tears a box down when the flag goes off, and never asks about budget', async () => {
    const store = recordingStore([project({ flagEnabled: false, box: box() })]);
    const result = await reconcileMonitorBoxesWithStore(store);
    expect(result.stopped).toBe(1);
    // No `budget` call: a flag-off project must not pay for an aggregate query.
    expect(store.calls).toEqual(['stop:box-1:monitors flag is off']);
  });

  test('a project with zero monitors and no box does nothing at all', async () => {
    const store = recordingStore([project({ monitors: [] })]);
    const result = await reconcileMonitorBoxesWithStore(store);
    expect(result).toMatchObject({ created: 0, stopped: 0, observed: 0, errors: 0 });
    expect(store.calls).toEqual([]);
  });

  test('drift restarts the box: stop THEN create, in that order', async () => {
    const store = recordingStore([project({ box: box({ manifestRevision: 'stale' }) })]);
    const result = await reconcileMonitorBoxesWithStore(store);
    expect(result.restarted).toBe(1);
    expect(store.calls).toEqual([
      'budget',
      'stop:box-1:manifest revision drift',
      `create:alpha@${monitorManifestRevision([monitor('alpha')])}`,
    ]);
  });

  test('a healthy box is observed — the only thing that keeps its meter alive', async () => {
    const revision = monitorManifestRevision([monitor('alpha')]);
    const store = recordingStore([project({ box: box({ manifestRevision: revision }) })]);
    const result = await reconcileMonitorBoxesWithStore(store);
    expect(result.observed).toBe(1);
    expect(store.calls).toEqual(['budget', 'observe:box-1']);
  });

  test('eleven monitors: ten run, the eleventh is disabled with a last_error', async () => {
    const monitors = Array.from({ length: 11 }, (_, index) =>
      monitor(`m${String(index).padStart(2, '0')}`),
    );
    const store = recordingStore([project({ monitors })]);
    const result = await reconcileMonitorBoxesWithStore(store);
    expect(result.disabledOverCap).toBe(1);
    expect(store.disabled).toEqual(['m10']);
    // The box is built from the capped ten, not all eleven.
    expect(store.calls.find((call) => call.startsWith('create:'))).toContain(
      'm00,m01,m02,m03,m04,m05,m06,m07,m08,m09@',
    );
  });

  test('budget exceeded stops the box and tells the owner exactly once', async () => {
    const revision = monitorManifestRevision([monitor('alpha')]);
    const store = recordingStore([project({ box: box({ manifestRevision: revision }) })], {
      budgetExceeded: true,
    });
    const result = await reconcileMonitorBoxesWithStore(store, new Date('2026-08-12T00:00:00Z'));
    expect(result.stopped).toBe(1);
    expect(store.calls).toEqual([
      'budget',
      'stop:box-1:monthly monitor compute budget exceeded',
      'lifecycle:alpha:budget_exceeded',
    ]);
    // Per-month epoch + seq 0 + ON CONFLICT DO NOTHING = one notice a month.
    expect(store.lifecycle[0]!.epoch).toBe('platform:budget:2026-08');
  });

  test('provisioning is bounded per pass; the overflow is deferred, not dropped', async () => {
    const projects = Array.from({ length: MONITOR_CREATES_PER_PASS + 3 }, (_, index) =>
      project({ projectId: `p-${index}` }),
    );
    const store = recordingStore(projects);
    const result = await reconcileMonitorBoxesWithStore(store);
    expect(result.created).toBe(MONITOR_CREATES_PER_PASS);
    expect(result.deferred).toBe(3);
    // Deferred, not lost: the same projects still want a box on the next tick.
    expect(store.calls.filter((call) => call.startsWith('create:'))).toHaveLength(
      MONITOR_CREATES_PER_PASS,
    );
  });

  test('a restart still STOPS a drifted box even when the create budget is spent', async () => {
    const drifted = box({ manifestRevision: 'stale' });
    const projects = [
      ...Array.from({ length: MONITOR_CREATES_PER_PASS }, (_, index) =>
        project({ projectId: `p-${index}` }),
      ),
      project({ projectId: 'p-drifted', box: drifted }),
    ];
    const store = recordingStore(projects);
    const result = await reconcileMonitorBoxesWithStore(store);
    // Running the WRONG manifest is worse than being briefly unwatched.
    expect(store.calls).toContain('stop:box-1:manifest revision drift');
    expect(result.deferred).toBe(1);
  });

  test('one project throwing does not stop the others from converging', async () => {
    const store = recordingStore([
      project({ projectId: 'p-bad' }),
      project({ projectId: 'p-good' }),
    ]);
    let first = true;
    store.createBox = async (proj, monitors, revision) => {
      if (first) {
        first = false;
        throw new Error('provider is down');
      }
      store.calls.push(`create:${proj.projectId}:${monitors.length}@${revision}`);
    };
    const result = await reconcileMonitorBoxesWithStore(store);
    expect(result.errors).toBe(1);
    expect(store.calls.some((call) => call.startsWith('create:p-good'))).toBe(true);
  });
});

describe('intersectMonitorSecretGrants', () => {
  // The shared box runs every monitor as one UID — any secret in the box is
  // readable by every monitor process, so a secret ships only when EVERY
  // enabled monitor's agent is granted it (Strix HIGH on PR #6413).
  test('one distinct agent keeps its grant unchanged', () => {
    const scoped = intersectMonitorSecretGrants(new Map([['default', ['a', 'b']]]));
    expect(scoped.grant).toEqual(['a', 'b']);
    expect(scoped.withheldByAgent.size).toBe(0);
    const unscoped = intersectMonitorSecretGrants(new Map([['default', 'all' as const]]));
    expect(unscoped.grant).toBe('all');
    expect(unscoped.withheldByAgent.size).toBe(0);
  });

  test('mixed agents intersect, and withheld identifiers are named per agent', () => {
    const { grant, withheldByAgent } = intersectMonitorSecretGrants(
      new Map([
        ['oncall', ['shared', 'pagerduty-key']],
        ['reporter', ['shared', 'sheets-key']],
      ]),
    );
    expect(grant).toEqual(['shared']);
    expect(withheldByAgent.get('oncall')).toEqual(['pagerduty-key']);
    expect(withheldByAgent.get('reporter')).toEqual(['sheets-key']);
  });

  test('an unscoped agent imposes no restriction but is itself narrowed', () => {
    const { grant, withheldByAgent } = intersectMonitorSecretGrants(
      new Map<string, string[] | 'all'>([
        ['default', 'all'],
        ['scoped', ['only-this']],
      ]),
    );
    expect(grant).toEqual(['only-this']);
    // Narrowed from unscoped: flagged with an empty identifier list.
    expect(withheldByAgent.get('default')).toEqual([]);
    expect(withheldByAgent.has('scoped')).toBe(false);
  });

  test('disjoint scoped grants intersect to nothing — the box gets no secrets', () => {
    const { grant, withheldByAgent } = intersectMonitorSecretGrants(
      new Map([
        ['a', ['x']],
        ['b', ['y']],
      ]),
    );
    expect(grant).toEqual([]);
    expect(withheldByAgent.get('a')).toEqual(['x']);
    expect(withheldByAgent.get('b')).toEqual(['y']);
  });
});
