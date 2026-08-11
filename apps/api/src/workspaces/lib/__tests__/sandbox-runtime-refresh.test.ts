import { describe, expect, test } from 'bun:test';
import {
  refreshSandboxRuntimeAssets,
  type SandboxRuntimeRefreshDeps,
} from '../sandbox-runtime-refresh';

const SANDBOX = { externalId: 'sbx-1', serviceKey: 'svc-key-1' };

function deps(overrides: Partial<SandboxRuntimeRefreshDeps> = {}): {
  deps: SandboxRuntimeRefreshDeps;
  calls: { url: string; init?: RequestInit }[];
  sleeps: number[];
} {
  const calls: { url: string; init?: RequestInit }[] = [];
  const sleeps: number[] = [];
  return {
    calls,
    sleeps,
    deps: {
      loadActiveSandbox: async () => SANDBOX,
      resolveIngress: async (externalId) => ({
        url: `http://localhost:8008/v1/p/${externalId}/8000/`,
        headers: { 'X-Ingress': '1' },
      }),
      fetch: async (input, init) => {
        calls.push({ url: String(input), init });
        return new Response(null, { status: 200 });
      },
      // Never actually wait in a test; just record the schedule.
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      ...overrides,
    },
  };
}

describe('refreshSandboxRuntimeAssets', () => {
  test('posts /kortix/refresh?restart=0 with the sandbox service key', async () => {
    const d = deps();
    const outcome = await refreshSandboxRuntimeAssets('sess-1', d.deps);

    expect(outcome).toBe('refreshed');
    expect(d.calls.length).toBe(1);
    expect(d.calls[0].url).toBe('http://localhost:8008/v1/p/sbx-1/8000/kortix/refresh?restart=0');
    expect(d.calls[0].init?.method).toBe('POST');
    const headers = d.calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer svc-key-1');
    expect(headers['X-Ingress']).toBe('1');
  });

  test('never sends base=1 or config_dir=1 — those are destructive/other jobs', async () => {
    const d = deps();
    await refreshSandboxRuntimeAssets('sess-1', d.deps);
    expect(d.calls[0].url).not.toContain('base=');
    expect(d.calls[0].url).not.toContain('config_dir=');
  });

  test('succeeds on a later attempt when the guest is still coming up', async () => {
    let attempt = 0;
    const d = deps({
      fetch: async () => {
        attempt += 1;
        if (attempt < 3) throw new Error('ECONNREFUSED');
        return new Response(null, { status: 200 });
      },
    });
    const outcome = await refreshSandboxRuntimeAssets('sess-1', d.deps);
    expect(outcome).toBe('refreshed');
    expect(attempt).toBe(3);
    // First attempt is immediate; the backoff grows.
    expect(d.sleeps).toEqual([5_000, 10_000]);
  });

  test('a 409 (refresh already running in the guest) counts as delivered', async () => {
    const d = deps({ fetch: async () => new Response(null, { status: 409 }) });
    expect(await refreshSandboxRuntimeAssets('sess-1', d.deps)).toBe('refreshed');
    expect(d.calls.length).toBe(0);
  });

  test('gives up after a bounded number of attempts', async () => {
    let attempts = 0;
    const d = deps({
      fetch: async () => {
        attempts += 1;
        return new Response(null, { status: 502 });
      },
    });
    expect(await refreshSandboxRuntimeAssets('sess-1', d.deps)).toBe('unreachable');
    expect(attempts).toBe(5);
    expect(d.sleeps).toEqual([5_000, 10_000, 15_000, 30_000]);
  });

  test('no active sandbox → no_sandbox, no HTTP at all', async () => {
    const d = deps({ loadActiveSandbox: async () => null });
    expect(await refreshSandboxRuntimeAssets('sess-1', d.deps)).toBe('no_sandbox');
    expect(d.calls.length).toBe(0);
  });

  test('a throwing dependency never propagates out of the helper', async () => {
    const d = deps({
      loadActiveSandbox: async () => {
        throw new Error('db down');
      },
    });
    expect(await refreshSandboxRuntimeAssets('sess-1', d.deps)).toBe('no_sandbox');
  });
});
