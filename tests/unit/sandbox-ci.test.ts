import { describe, expect, test, vi } from 'vitest';
import { parseSandboxCiProvider, runSandboxCi } from '../src/core/sandbox-ci';

describe('provider-neutral sandbox CI selection', () => {
  test('defaults to automatic failover and accepts explicit providers', () => {
    expect(parseSandboxCiProvider(undefined)).toBe('auto');
    expect(parseSandboxCiProvider('auto')).toBe('auto');
    expect(parseSandboxCiProvider('platinum')).toBe('platinum');
    expect(parseSandboxCiProvider('daytona')).toBe('daytona');
  });

  test('rejects unknown providers', () => {
    expect(() => parseSandboxCiProvider('docker')).toThrow(
      'TEST_SANDBOX_PROVIDER must be auto, platinum, or daytona',
    );
  });

  test('falls back only when Platinum infrastructure throws', async () => {
    const platinum = vi.fn().mockRejectedValue(new Error('restore timeout'));
    const daytona = vi.fn().mockResolvedValue(0);
    const input = {
      provider: 'auto' as const,
      platinum: { apiKey: 'platinum' },
      daytona: { apiKey: 'daytona' },
    } as Parameters<typeof runSandboxCi>[0];

    await expect(runSandboxCi(input, { platinum, daytona })).resolves.toBe(0);
    expect(platinum).toHaveBeenCalledOnce();
    expect(daytona).toHaveBeenCalledOnce();
  });

  test('does not hide a real test failure behind provider failover', async () => {
    const platinum = vi.fn().mockResolvedValue(7);
    const daytona = vi.fn().mockResolvedValue(0);
    const input = {
      provider: 'auto' as const,
      platinum: { apiKey: 'platinum' },
      daytona: { apiKey: 'daytona' },
    } as Parameters<typeof runSandboxCi>[0];

    await expect(runSandboxCi(input, { platinum, daytona })).resolves.toBe(7);
    expect(platinum).toHaveBeenCalledOnce();
    expect(daytona).not.toHaveBeenCalled();
  });
});
