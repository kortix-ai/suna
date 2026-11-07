import { beforeEach, describe, expect, mock, test } from 'bun:test';

const realDb = await import('../../shared/db');
let rows: Array<Record<string, unknown>> = [];
let updates = 0;
mock.module('../../shared/db', () => ({
  ...realDb,
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }),
    update: () => ({
      set: () => ({
        where: async () => {
          updates += 1;
        },
      }),
    }),
  },
}));

const { repairDeadDaemonOnEdgeRefusal } = await import('./legacy-runtime-bootstrap-wiring');
const { LEGACY_CHECK_METADATA_KEY } = await import('./legacy-runtime-bootstrap');
type Schedule = typeof import('./legacy-runtime-bootstrap-wiring').scheduleLegacyRuntimeBootstrap;

const PROVEN = { runtimeProvenAt: '2026-11-07T05:00:00.000Z' };
const box = (over: Record<string, unknown> = {}) => ({
  sandboxId: 'sb-1',
  sessionId: 's-1',
  accountId: 'a-1',
  projectId: 'p-1',
  provider: 'platinum',
  externalId: 'ext_sb-1',
  status: 'active',
  metadata: { ...PROVEN, [LEGACY_CHECK_METADATA_KEY]: { klass: 'current' } },
  ...over,
});

describe('repairDeadDaemonOnEdgeRefusal', () => {
  let scheduled: Array<[Record<string, unknown>, string]>;
  const schedule = ((row: Record<string, unknown>, reason: string) => {
    scheduled.push([row, reason]);
    return true;
  }) as unknown as Schedule;
  beforeEach(() => {
    scheduled = [];
    updates = 0;
    rows = [];
  });

  test('a running proven box: relaunch scheduled with the stale `current` verdict stripped, request stamped', async () => {
    rows = [box()];
    expect(await repairDeadDaemonOnEdgeRefusal('sb-1', schedule)).toBe(true);
    expect(scheduled).toHaveLength(1);
    const [row, reason] = scheduled[0];
    expect(reason).toBe('proxy-edge-refused-daemon');
    expect(row.metadata).toEqual(PROVEN);
    expect(updates).toBe(1);
  });

  test.each([
    ['unknown sandbox', []],
    ['not active', [box({ status: 'stopped' })]],
    ['no external id', [box({ externalId: null })]],
    ['booting: daemon never answered this boot', [box({ metadata: {} })]],
    ['relaunch already asked within budget', [box({ metadata: { ...PROVEN, deadDaemonRepairRequestedAt: new Date().toISOString() } })]],
  ])('%s: nothing scheduled, nothing stamped', async (_name, found) => {
    rows = found as Array<Record<string, unknown>>;
    expect(await repairDeadDaemonOnEdgeRefusal('sb-1', schedule)).toBe(false);
    expect(scheduled).toHaveLength(0);
    expect(updates).toBe(0);
  });

  test('the in-flight guard refusing the schedule leaves no stamp', async () => {
    rows = [box()];
    expect(await repairDeadDaemonOnEdgeRefusal('sb-1', (() => false) as unknown as Schedule)).toBe(false);
    expect(updates).toBe(0);
  });
});
