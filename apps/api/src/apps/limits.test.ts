import { describe, expect, test } from 'bun:test';
import {
  APP_MACHINE_LIMITS,
  AppLimitError,
  assertAppBudgetWithinLimits,
  assertAppMachineWithinLimits,
} from './limits';
import { DEFAULT_APP_MONTHLY_BUDGET_USD, alwaysOnBudgetWarning, appMonthlyEstimateUsd, defaultAppBudgetUsd } from './budget';
import { appRuntimeImageKey } from './deployment-worker';

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

describe('always-on cost', () => {
  const machine = { cpuCores: 1, memoryGb: 2, diskGb: 10 };

  test('the default machine costs about 73 USD for a month of 24/7 at list rates', () => {
    // 730 h × (1 × 0.0000168 + 2 × 0.0000054 + 10 × 0.000000036) USD/s
    expect(appMonthlyEstimateUsd(machine)).toBe(73.48);
    expect(appMonthlyEstimateUsd({ cpuCores: 2, memoryGb: 4, diskGb: 20 })).toBe(146.96);
  });

  test('warns only an always-on App whose budget is below its estimate', () => {
    const warning = alwaysOnBudgetWarning({ ...machine, alwaysOn: true, monthlyBudgetUsd: '5.00' });
    expect(warning).toMatchObject({
      code: 'app_budget_below_always_on', estimated_monthly_usd: 73.48, monthly_budget_usd: 5,
    });
    expect(warning?.message).toContain('after about 2.1 days');
    expect(alwaysOnBudgetWarning({ ...machine, alwaysOn: false, monthlyBudgetUsd: '5.00' })).toBeNull();
    expect(alwaysOnBudgetWarning({ ...machine, alwaysOn: true, monthlyBudgetUsd: '73.48' })).toBeNull();
  });
});

describe('runtime refresh key', () => {
  test('only the supervisor digest decides a refresh, not the API release', () => {
    expect(appRuntimeImageKey('0.13.52:appd-0123456789abcdef')).toBe('appd-0123456789abcdef');
    expect(appRuntimeImageKey('0.13.53:appd-0123456789abcdef')).toBe(appRuntimeImageKey('0.13.52:appd-0123456789abcdef'));
    expect(appRuntimeImageKey('0.13.53:appd-fedcba9876543210')).not.toBe(appRuntimeImageKey('0.13.52:appd-0123456789abcdef'));
    expect(appRuntimeImageKey('custom-override')).toBe('custom-override');
    expect(appRuntimeImageKey(null)).toBe('');
  });
});

describe('default App budget', () => {
  const small = { cpuCores: 1, memoryGb: 1, diskGb: 10 };
  const standard = { cpuCores: 1, memoryGb: 2, diskGb: 10 };

  test('an always-on App defaults to its 24/7 estimate rounded up to a whole dollar', () => {
    for (const machine of [small, standard]) {
      const budget = defaultAppBudgetUsd({ ...machine, alwaysOn: true });
      expect(Number.isInteger(budget)).toBe(true);
      expect(budget).toBe(Math.ceil(appMonthlyEstimateUsd(machine)));
      expect(budget).toBeGreaterThanOrEqual(appMonthlyEstimateUsd(machine));
      expect(alwaysOnBudgetWarning({ ...machine, alwaysOn: true, monthlyBudgetUsd: budget })).toBeNull();
    }
    expect(defaultAppBudgetUsd({ ...standard, alwaysOn: true })).toBeGreaterThan(
      defaultAppBudgetUsd({ ...small, alwaysOn: true }),
    );
  });

  test('an on-demand App keeps the flat default, whatever its size', () => {
    expect(DEFAULT_APP_MONTHLY_BUDGET_USD).toBe(5);
    expect(defaultAppBudgetUsd({ ...standard, alwaysOn: false })).toBe(5);
    expect(defaultAppBudgetUsd({ cpuCores: 8, memoryGb: 32, diskGb: 10, alwaysOn: false })).toBe(5);
  });

  test('a derived budget never exceeds the operator maximum', () => {
    expect(defaultAppBudgetUsd({ cpuCores: 1, memoryGb: 2, diskGb: 10, alwaysOn: true }, undefined, 50)).toBe(50);
  });
});
