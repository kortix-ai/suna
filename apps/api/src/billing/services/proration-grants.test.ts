import { describe, expect, test } from 'bun:test';
import { computeProrationGrant, type ProrationLine } from './proration-grants';

const line = (amount: number, proration = true): ProrationLine => ({ amount, proration });

describe('computeProrationGrant', () => {
  test('a raise grants its net paid amount 1:1 (`credits` is the wallet unit, USD)', () => {
    // $200 → $300 with 40% of the period left: -$80 unused + $120 new = $40.
    expect(computeProrationGrant([line(-8000), line(12000)])).toEqual({
      kind: 'raise',
      netCents: 4000,
      credits: 40,
    });
  });

  test('a raise late in the period buys proportionally fewer credits', () => {
    // 1/30 of the period left: -$6.67 unused + $10.00 new = $3.33.
    const decision = computeProrationGrant([line(-667), line(1000)]);
    expect(decision).toEqual({ kind: 'raise', netCents: 333, credits: 3.33 });
  });

  test('a cut collects no money and grants nothing', () => {
    const decision = computeProrationGrant([line(-5000), line(2500)]);
    expect(decision.kind).toBe('none');
  });

  test('a lone unused-time credit grants nothing', () => {
    expect(computeProrationGrant([line(-4000)]).kind).toBe('none');
  });

  test('non-proration lines are ignored', () => {
    const decision = computeProrationGrant([line(4000, false)]);
    expect(decision).toEqual({ kind: 'none', reason: 'no proration lines' });
  });

  test('a net zero change grants nothing', () => {
    expect(computeProrationGrant([line(-2500), line(2500)]).kind).toBe('none');
  });
});
