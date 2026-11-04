// Orphan box costs: what the reaper records before it stops a box no Kortix
// row owns. A failed read never keeps the reaper from stopping the box.
import { describe, expect, test } from 'bun:test';
import { recordOrphanBoxCost, type OrphanBoxCostDeps } from './orphan-box-costs';

function deps(usage: OrphanBoxCostDeps['usage']) {
  const recorded: Parameters<OrphanBoxCostDeps['record']>[0][] = [];
  const asked: Array<[string, number]> = [];
  return {
    recorded,
    asked,
    deps: {
      usage: async (id: string, since: number) => {
        asked.push([id, since]);
        return usage(id, since);
      },
      record: async (row: Parameters<OrphanBoxCostDeps['record']>[0]) => {
        recorded.push(row);
      },
    } satisfies OrphanBoxCostDeps,
  };
}

const createdAt = new Date('2026-11-01T10:25:00.000Z');

describe('recordOrphanBoxCost', () => {
  test("records Platinum's charge for the box since it was created, keyed by its creation day", async () => {
    const t = deps(async () => ({ cost_usd: 0.437812, uptime_seconds: 12_600 }));
    expect(await recordOrphanBoxCost({ provider: 'platinum', externalId: 'sbx_orphan', createdAt }, t.deps)).toBe(437_812);
    expect(t.asked).toEqual([['sbx_orphan', createdAt.getTime()]]);
    expect(t.recorded).toEqual([{ sandboxId: 'sbx_orphan', usageDay: '2026-11-01', uptimeSeconds: 12_600, amountMicros: 437_812 }]);
  });

  test('a failed read records nothing and does not throw', async () => {
    const t = deps(async () => {
      throw new Error('platinum unavailable');
    });
    expect(await recordOrphanBoxCost({ provider: 'platinum', externalId: 'sbx_orphan', createdAt }, t.deps)).toBeNull();
    expect(t.recorded).toEqual([]);
  });

  test('another provider, or a box with no creation time, is not read', async () => {
    const t = deps(async () => ({ cost_usd: 1 }));
    expect(await recordOrphanBoxCost({ provider: 'daytona', externalId: 'd1', createdAt }, t.deps)).toBeNull();
    expect(await recordOrphanBoxCost({ provider: 'platinum', externalId: 'p1', createdAt: null }, t.deps)).toBeNull();
    expect(t.asked).toEqual([]);
  });
});
