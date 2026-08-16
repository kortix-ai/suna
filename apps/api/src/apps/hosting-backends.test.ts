import { describe, expect, test } from 'bun:test';
import {
  lightsailPowerForMachine,
  minimumMonthlyHostingCost,
  resolveAppHostingSelection,
  validateAppHostingConfiguration,
} from './hosting-backends';

describe('Apps hosting backend selection', () => {
  test('omitted hosting preserves the current sandbox default', () => {
    expect(resolveAppHostingSelection({})).toEqual({
      type: 'sandbox',
      provider: null,
    });
  });

  test('legacy provider remains a sandbox-only shorthand', () => {
    expect(resolveAppHostingSelection({ provider: 'e2b' })).toEqual({
      type: 'sandbox',
      provider: 'e2b',
    });
  });

  test('managed container selection cannot be combined with legacy provider', () => {
    expect(() => resolveAppHostingSelection({
      provider: 'daytona',
      hosting: { type: 'managed_container', provider: 'aws_lightsail' },
    })).toThrow('provider cannot be combined with hosting');
  });

  test('Lightsail maps the existing default machine to medium at 40 USD monthly', () => {
    const machine = { cpuCores: 1, memoryGb: 2, diskGb: 10 };
    expect(lightsailPowerForMachine(machine)).toBe('medium');
    expect(minimumMonthlyHostingCost({
      type: 'managed_container',
      provider: 'aws_lightsail',
    }, machine)).toBe(40);
  });

  test('Lightsail rejects machine shapes it cannot allocate exactly', () => {
    expect(() => lightsailPowerForMachine({ cpuCores: 1, memoryGb: 4, diskGb: 10 }))
      .toThrow('does not support 1 vCPU and 4 GB memory');
  });

  test('Lightsail rejects fractional powers that the App resource contract cannot persist', () => {
    expect(() => lightsailPowerForMachine({ cpuCores: 0.25, memoryGb: 0.5, diskGb: 10 }))
      .toThrow('does not support 0.25 vCPU and 0.5 GB memory');
  });

  test('Lightsail configuration rejects a budget below the selected power price', () => {
    expect(validateAppHostingConfiguration(
      { type: 'managed_container', provider: 'aws_lightsail' },
      { cpuCores: 1, memoryGb: 2, diskGb: 10 },
      39.99,
    )).toEqual({
      ok: false,
      code: 'app_hosting_budget_too_low',
      requiredMonthlyUsd: 40,
      budgetUsd: 39.99,
      message: 'AWS Lightsail requires at least $40.00 per month for this machine',
    });
  });

  test('sandbox configuration has no managed-container monthly floor', () => {
    expect(validateAppHostingConfiguration(
      { type: 'sandbox', provider: 'daytona' },
      { cpuCores: 32, memoryGb: 128, diskGb: 500 },
      0,
    )).toEqual({ ok: true, requiredMonthlyUsd: 0 });
  });
});
