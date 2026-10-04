import { describe, expect, test } from 'bun:test';
import {
  APP_MACHINE_LIMITS,
  AppLimitError,
  assertAppBudgetWithinLimits,
  assertAppMachineWithinLimits,
} from './limits';

describe('App machine limits', () => {
  test('an App may not ask for a bigger machine than a session sandbox may', () => {
    // The App routes used to accept 64 CPU / 512 GB RAM / 2 TB disk while a
    // session snapshot was capped at 32 / 128 / 500 — and the App row was billed
    // for whatever it recorded. Apps now answer to the same ceiling.
    expect(APP_MACHINE_LIMITS.cpu.max).toBe(32);
    expect(APP_MACHINE_LIMITS.memory.max).toBe(128);
    expect(APP_MACHINE_LIMITS.disk.max).toBe(500);

    expect(() => assertAppMachineWithinLimits({ cpu: 32, memoryGb: 128, diskGb: 500 })).not.toThrow();
    expect(() => assertAppMachineWithinLimits({})).not.toThrow();
  });

  test('names the field, the bound, and what was asked for', () => {
    try {
      assertAppMachineWithinLimits({ cpu: 64 });
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(AppLimitError);
      const refusal = error as AppLimitError;
      expect(refusal.code).toBe('app_machine_out_of_range');
      expect(refusal.status).toBe(400);
      expect(refusal.detail).toMatchObject({ field: 'cpu', max: 32, requested: 64 });
    }
  });

  test('rejects every out-of-range dimension, including below the floor', () => {
    for (const machine of [
      { memoryGb: 512 },
      { diskGb: 2048 },
      { cpu: 0 },
      { memoryGb: 0 },
      { diskGb: 0 },
    ]) {
      expect(() => assertAppMachineWithinLimits(machine)).toThrow(AppLimitError);
    }
  });

  test('bounds the monthly budget and accepts an unset one', () => {
    expect(() => assertAppBudgetWithinLimits(undefined)).not.toThrow();
    expect(() => assertAppBudgetWithinLimits(0)).not.toThrow();
    expect(() => assertAppBudgetWithinLimits(5)).not.toThrow();
    expect(() => assertAppBudgetWithinLimits(-1)).toThrow(AppLimitError);
    expect(() => assertAppBudgetWithinLimits(100_001)).toThrow(AppLimitError);
  });
});
