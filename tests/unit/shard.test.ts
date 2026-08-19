import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { RegisteredFlow } from '../src/core/flow';
import {
  DEFAULT_FLOW_WEIGHT_MS,
  isPinnedToFirstShard,
  parseShardSpec,
  planShard,
} from '../src/core/shard';

function fakeFlow(
  id: string,
  meta: Partial<RegisteredFlow['meta']> = {},
): RegisteredFlow {
  return {
    id,
    meta: { domain: 'test', ...meta } as RegisteredFlow['meta'],
    fn: async () => {},
  };
}

describe('parseShardSpec', () => {
  it('accepts CURRENT/TOTAL inside range', () => {
    expect(parseShardSpec('1/4')).toEqual({ current: 1, total: 4 });
    expect(parseShardSpec('4/4')).toEqual({ current: 4, total: 4 });
  });

  it('rejects anything that is not a usable shard', () => {
    expect(() => parseShardSpec('1')).toThrow('CURRENT/TOTAL');
    expect(() => parseShardSpec('0/4')).toThrow('1 <= CURRENT <= TOTAL');
    expect(() => parseShardSpec('5/4')).toThrow('1 <= CURRENT <= TOTAL');
    expect(() => parseShardSpec('a/b')).toThrow('CURRENT/TOTAL');
  });
});

describe('planShard', () => {
  it('is a partition: every flow lands in exactly one shard', () => {
    const flows = Array.from({ length: 37 }, (_, i) =>
      fakeFlow(`F-${i}`, { timeoutMs: (i % 5) * 60_000 + 60_000 }),
    );
    const seen = new Map<string, number>();
    for (let current = 1; current <= 4; current++) {
      for (const id of planShard(flows, { current, total: 4 }).ids) {
        expect(seen.has(id)).toBe(false);
        seen.set(id, current);
      }
    }
    expect(seen.size).toBe(flows.length);
  });

  it('pins every serial and global flow to shard 1', () => {
    const flows = [
      fakeFlow('P-1'),
      fakeFlow('S-1', { serial: true }),
      fakeFlow('G-1', { global: true }),
      fakeFlow('SG-1', { serial: true, global: true }),
      fakeFlow('P-2'),
    ];
    expect(planShard(flows, { current: 1, total: 3 }).ids).toEqual(
      expect.arrayContaining(['S-1', 'G-1', 'SG-1']),
    );
    for (const current of [2, 3]) {
      const ids = planShard(flows, { current, total: 3 }).ids;
      expect(ids).not.toContain('S-1');
      expect(ids).not.toContain('G-1');
      expect(ids).not.toContain('SG-1');
    }
  });

  it('is deterministic — the same registry always yields the same partition', () => {
    const flows = Array.from({ length: 50 }, (_, i) =>
      fakeFlow(`F-${i}`, { timeoutMs: ((i * 7) % 9) * 30_000 + 30_000 }),
    );
    for (let current = 1; current <= 3; current++) {
      const first = planShard(flows, { current, total: 3 });
      const second = planShard([...flows].reverse(), { current, total: 3 });
      expect(second.ids).toEqual(first.ids);
    }
  });

  it('charges an undeclared timeout the runner default', () => {
    const [only] = [fakeFlow('F-1')];
    expect(planShard([only], { current: 1, total: 2 }).loads[0]).toBe(DEFAULT_FLOW_WEIGHT_MS);
  });

  it('balances the parallel work instead of splitting by count', () => {
    const flows = [
      fakeFlow('SLOW-1', { timeoutMs: 600_000 }),
      ...Array.from({ length: 10 }, (_, i) => fakeFlow(`FAST-${i}`, { timeoutMs: 60_000 })),
    ];
    const loads = planShard(flows, { current: 1, total: 2 }).loads;
    // Longest-first: the 600s flow alone, the ten 60s flows opposite it.
    expect(loads[0]).toBe(600_000);
    expect(loads[1]).toBe(600_000);
  });

  it('degenerates to the whole suite at --shard 1/1', () => {
    const flows = [fakeFlow('A-1'), fakeFlow('B-1', { serial: true })];
    expect(planShard(flows, { current: 1, total: 1 }).ids).toEqual(['A-1', 'B-1']);
  });
});

/**
 * The real registry, through the real runner.
 *
 * The flow modules and `discoverFlows` are Bun-only (`import.meta.dir`, Bun's
 * `Glob`), so vitest cannot import them. Running the partition inside `bun` is
 * also the more honest check: it exercises the exact code path `ke2e run
 * --shard` takes, not a re-implementation of it.
 */
interface RegistryShardReport {
  total: number;
  shards: number;
  perShard: number[];
  duplicates: string[];
  missing: string[];
  pinned: string[];
  pinnedOffShardOne: string[];
}

function shardTheRealRegistry(shards: number): RegistryShardReport {
  const testsDir = resolve(import.meta.dirname, '..');
  const script = `
    const { discoverFlows } = await import(${JSON.stringify(`${testsDir}/src/core/runner.ts`)});
    const { allFlows } = await import(${JSON.stringify(`${testsDir}/src/core/flow.ts`)});
    const { planShard, isPinnedToFirstShard } = await import(${JSON.stringify(`${testsDir}/src/core/shard.ts`)});
    await discoverFlows();
    const flows = allFlows();
    const total = ${shards};
    const owner = new Map();
    const duplicates = [];
    const perShard = [];
    for (let current = 1; current <= total; current++) {
      const ids = planShard(flows, { current, total }).ids;
      perShard.push(ids.length);
      for (const id of ids) {
        if (owner.has(id)) duplicates.push(id);
        else owner.set(id, current);
      }
    }
    const pinned = flows.filter(isPinnedToFirstShard).map((f) => f.id).sort();
    const shardOne = new Set(planShard(flows, { current: 1, total }).ids);
    console.log(JSON.stringify({
      total: flows.length,
      shards: total,
      perShard,
      duplicates,
      missing: flows.filter((f) => !owner.has(f.id)).map((f) => f.id),
      pinned,
      pinnedOffShardOne: pinned.filter((id) => !shardOne.has(id)),
    }));
  `;
  const out = execFileSync('bun', ['-e', script], { encoding: 'utf8', cwd: testsDir });
  return JSON.parse(out.trim().split('\n').at(-1) as string) as RegistryShardReport;
}

describe('the real flow registry', () => {
  const reports = new Map<number, RegistryShardReport>();

  beforeAll(() => {
    for (const shards of [2, 3, 4]) reports.set(shards, shardTheRealRegistry(shards));
  }, 120_000);

  it('discovers the whole suite', () => {
    expect(reports.get(4)!.total).toBeGreaterThan(400);
    expect(reports.get(4)!.pinned.length).toBeGreaterThan(0);
  });

  for (const shards of [2, 3, 4]) {
    it(`assigns every registered flow to exactly one of ${shards} shards`, () => {
      const report = reports.get(shards)!;
      expect(report.duplicates, 'flows claimed by more than one shard').toEqual([]);
      expect(report.missing, 'flows assigned to no shard').toEqual([]);
      expect(report.perShard.reduce((a, b) => a + b, 0)).toBe(report.total);
    });

    it(`keeps every serial and global flow on shard 1 of ${shards}`, () => {
      // Two jobs running ADM-19 / BILL-13 / CONN-5 at once would corrupt the
      // platform-wide state they mutate.
      expect(reports.get(shards)!.pinnedOffShardOne).toEqual([]);
    });
  }
});
