import { describe, expect, spyOn, test } from 'bun:test';
import { manifestBudget } from '../commands/apps-deploy';

describe('manifestBudget', () => {
  test('applies to an on-demand server App', () => {
    expect(manifestBudget({ monthly_budget_usd: 12, always_on: false } as never, undefined, {} as never)).toBe(12);
  });

  test('is dropped with a notice for an always-on or convex App', () => {
    const write = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(manifestBudget({ monthly_budget_usd: 12 } as never, undefined, {} as never)).toBeUndefined();
      expect(manifestBudget({ monthly_budget_usd: 12, always_on: false, kind: 'convex' } as never, undefined, {} as never)).toBeUndefined();
      expect(write).toHaveBeenCalledTimes(2);
      expect(String(write.mock.calls[0]?.[0])).toContain('monthly_budget_usd in kortix.yaml is ignored');
    } finally {
      write.mockRestore();
    }
  });

  test('an existing on-demand App keeps its manifest budget; --always-on drops it', () => {
    const existing = { kind: 'web', always_on: false } as never;
    expect(manifestBudget({ monthly_budget_usd: 9 } as never, existing, {} as never)).toBe(9);
    const write = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(manifestBudget({ monthly_budget_usd: 9 } as never, existing, { alwaysOn: true } as never)).toBeUndefined();
    } finally {
      write.mockRestore();
    }
  });
});
