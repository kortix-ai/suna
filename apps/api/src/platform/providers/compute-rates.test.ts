// The customer rates are Platinum's list prices × one markup. Money logic: a
// drift between the compute card and the markup the storage rates use would
// charge storage at a margin nobody chose.
import { describe, expect, test } from 'bun:test';
import {
  getProviderComputeRateCard,
  PLATINUM_LIST_PRICE_MICROS,
  PLATINUM_MARKUP,
  STORAGE_RATES_USD_PER_GIB_HOUR,
} from './compute-rates';

const micros = (usd: number) => usd * 1_000_000;

describe('customer rates', () => {
  test('compute is Platinum list price × PLATINUM_MARKUP for vCPU and RAM', () => {
    const card = getProviderComputeRateCard('platinum');
    expect(micros(card.cpuPerCoreSecond) / PLATINUM_LIST_PRICE_MICROS.cpuCoreSecond).toBeCloseTo(PLATINUM_MARKUP, 12);
    expect(micros(card.memoryPerGbSecond) / PLATINUM_LIST_PRICE_MICROS.ramGibSecond).toBeCloseTo(PLATINUM_MARKUP, 12);
  });

  test('storage is Platinum volume price × the same markup, per GiB-hour', () => {
    expect(STORAGE_RATES_USD_PER_GIB_HOUR).toEqual({
      volume: 0.000082,
      volume_snapshot: 0.000055,
      scratch: 0.000036,
    });
    // ≈ 6 credits per GiB-month (730 h, 1 credit = $0.01).
    expect(STORAGE_RATES_USD_PER_GIB_HOUR.volume * 730 * 100).toBeCloseTo(5.986, 3);
  });
});
