import { describe, expect, it } from 'vitest';

import { listSpecFiles, loadDurations, planBrowserShard } from '../src/core/browser-shard';
import { medianTable, parseSpecSeconds } from '../bin/refresh-shard-durations';
import { buildLocalTestPlan } from '../src/core/local-runner';

const plan = (specs: string[], durations: Record<string, number>, current: number, total: number) =>
  planBrowserShard({ specs, durations, current, total });

describe('browser shard planner', () => {
  const specs = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const durations = { a: 100, b: 90, c: 50, d: 40, e: 30, f: 20, g: 10 };

  it('assigns every spec to exactly one shard', () => {
    for (const total of [2, 3, 4]) {
      const all = Array.from({ length: total }, (_, i) => plan(specs, durations, i + 1, total)).flat();
      expect([...all].sort()).toEqual(specs);
    }
  });

  it('is deterministic and ignores input order', () => {
    expect(plan([...specs].reverse(), durations, 2, 3)).toEqual(plan(specs, durations, 2, 3));
  });

  it('packs longest-first onto the lightest shard, ties by path', () => {
    expect(plan(specs, durations, 1, 3)).toEqual(['a', 'g']);
    expect(plan(['y', 'x'], { x: 5, y: 5 }, 1, 2)).toEqual(['x']);
  });

  it('weights an unknown spec at the median of the known ones', () => {
    // median of {10,20,30} is 20: the new spec packs like a 20 s file.
    const d = { a: 30, b: 20, c: 10 };
    const withNew = ['a', 'b', 'c', 'new'];
    expect(plan(withNew, d, 1, 2).concat(plan(withNew, d, 2, 2)).sort()).toEqual(withNew);
    expect(plan(withNew, d, 1, 2)).toEqual(['a', 'c']);
    expect(plan(withNew, d, 2, 2)).toEqual(['b', 'new']);
  });

  it('refuses an empty shard: no file list would make Playwright run everything', () => {
    expect(() => plan(['a'], { a: 1 }, 2, 2)).toThrow('no spec files');
  });
});

describe('browser shard planner on the committed tables', () => {
  const specs = listSpecFiles();

  for (const target of ['local', 'deployed'] as const) {
    const durations = loadDurations(target);

    it(`${target}: every spec file on disk is in the table (run bin/refresh-shard-durations.ts after adding one)`, () => {
      // A missing spec still runs (median weight); this keeps the table fresh.
      expect(specs.filter((s) => !(s in durations))).toEqual([]);
    });

    it(`${target}: covers every spec once for 3, 4, 6 and 8 shards`, () => {
      for (const total of [3, 4, 6, 8]) {
        const all = Array.from({ length: total }, (_, i) =>
          planBrowserShard({ specs, durations, current: i + 1, total }),
        ).flat();
        expect([...all].sort()).toEqual(specs);
      }
    });

    it(`${target}: balances 8 shards within 15% of the ideal, or the largest file`, () => {
      const total = 8;
      const loads = Array.from({ length: total }, (_, i) =>
        planBrowserShard({ specs, durations, current: i + 1, total })
          .reduce((sum, s) => sum + (durations[s] ?? 0), 0),
      );
      const mean = loads.reduce((a, b) => a + b, 0) / total;
      const largest = Math.max(...specs.map((s) => durations[s] ?? 0));
      expect(Math.max(...loads)).toBeLessThanOrEqual(Math.max(mean * 1.15, largest));
    });
  }
});

describe('--browser-shard parsing', () => {
  it('rejects malformed, out-of-range and single-shard values', () => {
    for (const bad of ['', '0/2', '3/2', '1/1', 'a/b', '1-2']) {
      expect(() => buildLocalTestPlan(['--browser-only', `--browser-shard=${bad}`])).toThrow();
    }
  });
});

describe('refresh-shard-durations', () => {
  it('sums every attempt of a spec file, including retries and ms/m units', () => {
    const log = [
      '2026-10-12T03:43:14.6Z   ✓   1 [chromium] › e2e/specs/00-a.spec.ts:46:3 › A › one (8.4s)',
      '2026-10-12T03:43:22.7Z   ✘   2 [chromium] › e2e/specs/00-a.spec.ts:94:3 › A › two (500ms)',
      '2026-10-12T03:43:23.7Z   ✓   3 [chromium] › e2e/specs/00-a.spec.ts:94:3 › A › two (retry #1) (1.5m)',
      '2026-10-12T03:43:24.7Z   -   4 [chromium] › e2e/specs/01-b.spec.ts:9:3 › B › skipped',
    ].join('\n');
    expect(parseSpecSeconds(log)).toEqual({ 'e2e/specs/00-a.spec.ts': 8.4 + 0.5 + 90 });
  });

  it('takes the median over runs per spec', () => {
    expect(medianTable([{ x: 10 }, { x: 30 }, { x: 20, y: 4 }])).toEqual({ x: 20, y: 4 });
  });
});
