import { describe, expect, test, vi } from 'vitest';
import { SandboxWorkerInfrastructureError } from '../src/core/platinum-ci';
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

  test('retries one Daytona worker when its host cannot start nested Docker', async () => {
    const platinum = vi.fn();
    const daytona = vi
      .fn()
      .mockRejectedValueOnce(
        new SandboxWorkerInfrastructureError(
          'daytona',
          'Daytona worker host could not start nested Docker',
        ),
      )
      .mockResolvedValueOnce(0);
    const input = {
      provider: 'daytona' as const,
      platinum: { apiKey: '' },
      daytona: { apiKey: 'daytona', runAttempt: '1' },
    } as Parameters<typeof runSandboxCi>[0];

    await expect(runSandboxCi(input, { platinum, daytona })).resolves.toBe(0);
    expect(platinum).not.toHaveBeenCalled();
    expect(daytona).toHaveBeenCalledTimes(2);
    expect(daytona.mock.calls[1]?.[0].runAttempt).toBe('1-infra2');
  });

  test('does not retry a Daytona test-process failure', async () => {
    const platinum = vi.fn();
    const daytona = vi.fn().mockResolvedValue(7);
    const input = {
      provider: 'daytona' as const,
      platinum: { apiKey: '' },
      daytona: { apiKey: 'daytona', runAttempt: '1' },
    } as Parameters<typeof runSandboxCi>[0];

    await expect(runSandboxCi(input, { platinum, daytona })).resolves.toBe(7);
    expect(daytona).toHaveBeenCalledOnce();
  });
});
