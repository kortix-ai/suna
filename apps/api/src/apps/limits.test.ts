import { describe, expect, test } from 'bun:test';
import {
  APP_MACHINE_LIMITS,
  AppLimitError,
  assertAppBudgetApplies,
  assertAppBudgetWithinLimits,
  assertAppMachineWithinLimits,
} from './limits';
import { DEFAULT_APP_MONTHLY_BUDGET_USD, appHasBudget, appMonthlyEstimateUsd } from './budget';
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

describe('which App has a monthly budget (cost shape)', () => {
  const machine = { cpuCores: 1, memoryGb: 2, diskGb: 10 };

  test('only an on-demand server App has one; its default is $5', () => {
    expect(DEFAULT_APP_MONTHLY_BUDGET_USD).toBe(5);
    expect(appHasBudget({ kind: 'web', alwaysOn: false })).toBe(true);
    expect(appHasBudget({ kind: 'web', alwaysOn: false }, 'sandbox')).toBe(true);
    expect(appHasBudget({ kind: 'web', alwaysOn: true })).toBe(false);
    expect(appHasBudget({ kind: 'web', alwaysOn: false }, 'static')).toBe(false);
    expect(appHasBudget({ kind: 'convex', alwaysOn: true }, 'convex')).toBe(false);
  });

  test('a budget on a fixed-cost or static App is refused with app_budget_not_applicable and the reason', () => {
    expect(() => assertAppBudgetApplies(10, { ...machine, kind: 'web', alwaysOn: false }, 'sandbox')).not.toThrow();
    expect(() => assertAppBudgetApplies(undefined, { ...machine, kind: 'web', alwaysOn: true }, null)).not.toThrow();
    const refusal = (app: { kind: string; alwaysOn: boolean }, hosting: string | null) => {
      try {
        assertAppBudgetApplies(10, { ...machine, ...app }, hosting);
      } catch (error) {
        return error as AppLimitError;
      }
      throw new Error('expected a refusal');
    };
    const alwaysOn = refusal({ kind: 'web', alwaysOn: true }, 'sandbox');
    expect(alwaysOn).toMatchObject({ code: 'app_budget_not_applicable', status: 400, detail: { estimated_monthly_usd: 73.48 } });
    expect(alwaysOn.message).toContain('about $73.48 a month');
    expect(alwaysOn.message).toContain('always_on: false');
    expect(refusal({ kind: 'convex', alwaysOn: true }, 'convex').message).toContain('A convex App has no monthly budget');
    const staticApp = refusal({ kind: 'web', alwaysOn: false }, 'static');
    expect(staticApp.message).toContain('static App runs no machine');
    expect(staticApp.detail).toEqual({ estimated_monthly_usd: 0 });
  });
});
