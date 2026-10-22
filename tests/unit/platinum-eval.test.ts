import { describe, expect, it } from 'vitest';
import { plan, workloads } from '../bin/platinum-eval';

describe('Platinum evaluation plan', () => {
  it('assigns the requested proportions and covers 2–36 GB', () => {
    const cases = plan(600);
    expect(new Set(cases.map((item) => item.sizeGb))).toEqual(new Set([2, 4, 8, 16, 24, 36]));
    for (const { name, percent } of workloads) {
      expect(cases.filter((item) => item.workload.name === name).length).toBe(6 * percent);
    }
  });
  it('rejects unbounded or invalid runs', () => {
    for (const count of [0, -1, 1.5, 1001, NaN]) expect(() => plan(count)).toThrow();
  });
});
