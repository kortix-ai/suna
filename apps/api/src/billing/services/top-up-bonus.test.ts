import { describe, expect, test } from 'bun:test';
import { TOP_UP_BONUS_STEPS, topUpBonusUsd } from './tiers';
import { creditForRefund } from './refund-clawback';

describe('top-up bonus ladder', () => {
  test('no bonus below $50', () => {
    expect(topUpBonusUsd(10)).toBe(0);
    expect(topUpBonusUsd(49.99)).toBe(0);
  });

  test('a little more at each step, flat from $1,000', () => {
    expect(topUpBonusUsd(50)).toBe(0.5);
    expect(topUpBonusUsd(100)).toBe(2);
    expect(topUpBonusUsd(250)).toBe(7.5);
    expect(topUpBonusUsd(500)).toBe(20);
    expect(topUpBonusUsd(1_000)).toBe(50);
    expect(topUpBonusUsd(5_000)).toBe(250);
  });

  test('the percentage never falls as the amount grows, and caps at 5%', () => {
    let last = 0;
    for (let usd = 1; usd <= 20_000; usd += 7) {
      const pct = topUpBonusUsd(usd) / usd;
      expect(pct + 1e-9).toBeGreaterThanOrEqual(last);
      expect(pct).toBeLessThanOrEqual(0.05 + 1e-9);
      last = pct;
    }
    expect(Math.max(...TOP_UP_BONUS_STEPS.map((s) => s.percent))).toBe(5);
  });
});

describe('refund clawback takes the bonus share back', () => {
  test('a full refund of a $1,000 top-up takes back $1,050', () => {
    expect(creditForRefund(1_000, 1_000)).toBe(1_050);
  });

  test('a half refund takes back half the bonus', () => {
    expect(creditForRefund(500, 1_000)).toBe(525);
  });

  test('a top-up below the first step has no bonus to take back', () => {
    expect(creditForRefund(25, 25)).toBe(25);
  });
});
