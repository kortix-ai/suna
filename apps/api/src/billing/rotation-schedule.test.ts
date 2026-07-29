import { describe, expect, test } from 'bun:test';
import { billingRotationIntervalsEnabled } from './rotation-schedule';

describe('billingRotationIntervalsEnabled', () => {
  test('starts rotations only on a billing-enabled worker deployment', () => {
    expect(
      billingRotationIntervalsEnabled({
        KORTIX_BILLING_INTERNAL_ENABLED: true,
        KORTIX_WORKERS_ENABLED: true,
      }),
    ).toBe(true);
    expect(
      billingRotationIntervalsEnabled({
        KORTIX_BILLING_INTERNAL_ENABLED: true,
        KORTIX_WORKERS_ENABLED: false,
      }),
    ).toBe(false);
    expect(
      billingRotationIntervalsEnabled({
        KORTIX_BILLING_INTERNAL_ENABLED: false,
        KORTIX_WORKERS_ENABLED: true,
      }),
    ).toBe(false);
  });
});
