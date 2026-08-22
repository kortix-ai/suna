import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { retryDelayMs } from '../src/fixtures/provision';
import { fundingFailureIsFatal, fundingFailureMessage } from '../src/fixtures/principals';
import type { Env } from '../src/core/env';

function envWith(capabilities: Partial<Env['capabilities']>): Pick<Env, 'capabilities'> {
  return { capabilities: capabilities as Env['capabilities'] };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// P1.5 — provisioning concurrency and its jittered backoff.
// ---------------------------------------------------------------------------

describe('provision retry backoff (P1.5)', () => {
  it('replaces the fixed 120s rate-limit wait with exponential backoff', () => {
    const ceilings = [0, 1, 2, 3, 4].map((attempt) => retryDelayMs(attempt, true, () => 1));

    expect(ceilings).toEqual([15_000, 30_000, 60_000, 120_000, 120_000]);
    // The old policy waited a flat 120s on the FIRST rate-limited retry.
    expect(ceilings[0]).toBeLessThan(120_000);
  });

  it('applies equal jitter so concurrent provisions never retry in lockstep', () => {
    expect(retryDelayMs(0, true, () => 0)).toBe(7_500);
    expect(retryDelayMs(0, true, () => 0.5)).toBe(11_250);
    expect(retryDelayMs(0, true, () => 1)).toBe(15_000);
  });

  it('keeps a non-zero floor — a near-instant retry re-trips a secondary rate limit', () => {
    for (const attempt of [0, 1, 2, 3]) {
      expect(retryDelayMs(attempt, true, () => 0)).toBeGreaterThan(0);
      expect(retryDelayMs(attempt, false, () => 0)).toBeGreaterThan(0);
    }
  });

  it('jitters the non-rate-limited 5s→30s backoff too', () => {
    expect(retryDelayMs(0, false, () => 1)).toBe(5_000);
    expect(retryDelayMs(0, false, () => 0)).toBe(2_500);
    expect(retryDelayMs(9, false, () => 1)).toBe(30_000);
  });
});

describe('provision concurrency default (P1.5)', () => {
  it('allows 4 concurrent provisions by default, not 2', async () => {
    vi.stubEnv('KE2E_PROVISION_CONCURRENCY', '');
    vi.unstubAllEnvs();
    delete process.env.KE2E_PROVISION_CONCURRENCY;
    vi.resetModules();
    const { provisionProject } = await import('../src/fixtures/provision');

    let active = 0;
    let maxActive = 0;
    const release: Array<() => void> = [];
    const post = vi.fn().mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => release.push(resolve));
      active--;
      return {
        statusCode: 200,
        text: () => '{"project_id":"p"}',
        json: <T>() => ({ project_id: 'p' }) as T,
      };
    });
    const client = { post } as never;

    const inflight = Array.from({ length: 8 }, () => provisionProject(client, { name: 'x' }));
    // Let the semaphore hand out every slot it is willing to.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const grantedFirstWave = maxActive;
    for (const resolve of [...release]) resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
    for (const resolve of [...release]) resolve();
    await Promise.all(inflight);

    expect(grantedFirstWave).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// P0.3 — OWNER funding is fatal on a Stripe-capable target.
// ---------------------------------------------------------------------------

describe('OWNER funding failure policy (P0.3)', () => {
  it('is FATAL when the target declares the stripe capability', () => {
    expect(fundingFailureIsFatal(envWith({ stripe: true }), {})).toBe(true);
  });

  it('stays soft on a local profile without stripe', () => {
    expect(fundingFailureIsFatal(envWith({ stripe: false }), {})).toBe(false);
  });

  it('restores soft-fail with KE2E_FUNDING_OPTIONAL', () => {
    expect(
      fundingFailureIsFatal(envWith({ stripe: true }), { KE2E_FUNDING_OPTIONAL: '1' }),
    ).toBe(false);
    expect(
      fundingFailureIsFatal(envWith({ stripe: true }), { KE2E_FUNDING_OPTIONAL: 'true' }),
    ).toBe(false);
    expect(
      fundingFailureIsFatal(envWith({ stripe: true }), { KE2E_FUNDING_OPTIONAL: '0' }),
    ).toBe(true);
  });

  it('names the consequence, the escape hatch, and the cause', () => {
    const message = fundingFailureMessage(new Error('Stripe PI confirm failed: 402'));

    expect(message).toContain('`funded`');
    expect(message).toContain('Failing fast');
    expect(message).toContain('KE2E_FUNDING_OPTIONAL=1');
    expect(message).toContain('Stripe PI confirm failed: 402');
  });
});

// ---------------------------------------------------------------------------
// P1.7 — provisionMatrix runs the OWNER chain and NONMEMBER at the same time.
// ---------------------------------------------------------------------------

interface Window {
  label: string;
  startedAt: number;
  endedAt: number;
}

async function loadProvisionMatrix(opts: {
  windows: Window[];
  subscribe: () => Promise<void>;
  createDelayMs?: number;
}) {
  const delay = opts.createDelayMs ?? 25;
  vi.doMock('../src/fixtures/supabase', () => ({
    adminCreateUser: async (_env: unknown, email: string) => {
      const label = email.includes('nonmember') ? 'NONMEMBER' : 'OWNER';
      const startedAt = performance.now();
      await new Promise((resolve) => setTimeout(resolve, delay));
      opts.windows.push({ label, startedAt, endedAt: performance.now() });
      return { id: `${label}-user-id` };
    },
    passwordGrant: async () => 'jwt-token',
    adminDeleteUser: async () => undefined,
  }));
  vi.doMock('../src/fixtures/billing', () => ({ subscribe: opts.subscribe }));
  vi.doMock('../src/core/client', () => ({
    Client: class {
      as() {
        return this;
      }
      async post() {
        await new Promise((resolve) => setTimeout(resolve, delay));
        return {
          status() {
            return this;
          },
          json: () => ({ secret_key: 'pat-secret' }),
          text: () => '',
        };
      }
    },
  }));
  vi.resetModules();
  return (await import('../src/fixtures/principals')).provisionMatrix;
}

describe('provisionMatrix parallelism (P1.7)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('../src/fixtures/supabase');
    vi.doUnmock('../src/fixtures/billing');
    vi.doUnmock('../src/core/client');
    vi.resetModules();
  });

  it('creates NONMEMBER at the same time as the OWNER chain', async () => {
    const windows: Window[] = [];
    const provisionMatrix = await loadProvisionMatrix({
      windows,
      subscribe: async () => undefined,
    });

    const env = {
      apiUrl: 'https://example.test/v1',
      testEmailDomain: 'ke2e.kortix.test',
      capabilities: { stripe: false },
    } as unknown as Env;
    const result = await provisionMatrix(env, 'run-1');

    const owner = windows.find((w) => w.label === 'OWNER')!;
    const nonmember = windows.find((w) => w.label === 'NONMEMBER')!;
    expect(owner.startedAt < nonmember.endedAt && nonmember.startedAt < owner.endedAt).toBe(
      true,
    );
    expect(result.supabaseUserIds).toEqual(['OWNER-user-id', 'NONMEMBER-user-id']);
    expect(result.principals.PAT_ACCT?.auth).toEqual({
      mode: 'bearer',
      token: 'pat-secret',
    });
  });

  it('throws immediately when funding fails on a stripe-capable target', async () => {
    const windows: Window[] = [];
    const provisionMatrix = await loadProvisionMatrix({
      windows,
      subscribe: async () => {
        throw new Error('Stripe PI confirm failed: 402');
      },
    });

    const env = {
      apiUrl: 'https://example.test/v1',
      testEmailDomain: 'ke2e.kortix.test',
      capabilities: { stripe: true, funded: false },
    } as unknown as Env;

    await expect(provisionMatrix(env, 'run-2')).rejects.toThrow(/OWNER funding failed/);
  });

  it('cleans up NONMEMBER instead of stranding it when the OWNER chain fails', async () => {
    const deleted: string[] = [];
    vi.doMock('../src/fixtures/supabase', () => ({
      adminCreateUser: async (_env: unknown, email: string) => ({
        id: email.includes('nonmember') ? 'NONMEMBER-user-id' : 'OWNER-user-id',
      }),
      passwordGrant: async () => 'jwt-token',
      adminDeleteUser: async (_env: unknown, id: string) => {
        deleted.push(id);
      },
    }));
    vi.doMock('../src/fixtures/billing', () => ({
      subscribe: async () => {
        throw new Error('Stripe down');
      },
    }));
    vi.doMock('../src/core/client', () => ({
      Client: class {
        as() {
          return this;
        }
        async post() {
          return {
            status() {
              return this;
            },
            json: () => ({ secret_key: 's' }),
            text: () => '',
          };
        }
      },
    }));
    vi.resetModules();
    const { provisionMatrix } = await import('../src/fixtures/principals');

    const env = {
      apiUrl: 'https://example.test/v1',
      testEmailDomain: 'ke2e.kortix.test',
      capabilities: { stripe: true },
    } as unknown as Env;

    await expect(provisionMatrix(env, 'run-4')).rejects.toThrow(/OWNER funding failed/);
    expect(deleted).toEqual(['NONMEMBER-user-id']);
  });

  it('warns instead of throwing when KE2E_FUNDING_OPTIONAL is set', async () => {
    vi.stubEnv('KE2E_FUNDING_OPTIONAL', '1');
    const windows: Window[] = [];
    const provisionMatrix = await loadProvisionMatrix({
      windows,
      subscribe: async () => {
        throw new Error('Stripe PI confirm failed: 402');
      },
    });

    const env = {
      apiUrl: 'https://example.test/v1',
      testEmailDomain: 'ke2e.kortix.test',
      capabilities: { stripe: true, funded: false },
    } as unknown as Env;

    const result = await provisionMatrix(env, 'run-3');
    expect(result.principals.OWNER).toBeDefined();
    expect(env.capabilities.funded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P1.7 — buildWorld provisions the platform admin BESIDE provisionMatrix.
// ---------------------------------------------------------------------------

describe('buildWorld provisioning parallelism (P1.7)', () => {
  afterEach(() => {
    vi.doUnmock('../src/fixtures/principals');
    vi.doUnmock('../src/fixtures/platform-admin');
    vi.doUnmock('../src/fixtures/supabase');
    vi.doUnmock('../src/core/client');
    vi.resetModules();
  });

  it('overlaps provisionMatrix with the platform-admin grant', async () => {
    const windows: Window[] = [];
    const record = async (label: string, ms: number) => {
      const startedAt = performance.now();
      await new Promise((resolve) => setTimeout(resolve, ms));
      windows.push({ label, startedAt, endedAt: performance.now() });
    };

    vi.doMock('../src/fixtures/principals', () => ({
      provisionMatrix: async () => {
        await record('matrix', 30);
        return {
          principals: {
            OWNER: { label: 'OWNER', auth: { mode: 'bearer', token: 't' }, accountId: 'a', userId: 'u' },
            ANON: { label: 'ANON', auth: { mode: 'none' } },
            accountId: 'a',
          },
          runAccountIds: [],
          supabaseUserIds: ['OWNER-user-id'],
        };
      },
      synthUser: async () => {
        await record('platform-admin-user', 30);
        return { user: { id: 'ADMIN-user-id' }, jwt: 'admin-jwt', principal: {} };
      },
      synthUserWithEmail: async () => ({ user: { id: 'x' }, jwt: 'j', principal: {} }),
    }));
    vi.doMock('../src/fixtures/platform-admin', () => ({
      grantEphemeralPlatformAdmin: async () => async () => undefined,
    }));
    vi.doMock('../src/fixtures/supabase', () => ({ adminDeleteUser: async () => undefined }));
    vi.doMock('../src/core/client', () => ({
      Client: class {
        as() {
          return this;
        }
      },
    }));
    vi.resetModules();
    const { buildWorld } = await import('../src/fixtures/world');

    const env = {
      apiUrl: 'https://example.test/v1',
      target: 'staging',
      supabaseAnonKey: 'anon',
      testEmailDomain: 'ke2e.kortix.test',
      capabilities: { supabaseAdmin: true, database: true },
    } as unknown as Env;

    const world = await buildWorld(env, [
      { id: 'ACC-1', meta: { domain: 'accounts' }, fn: async () => {} } as never,
    ]);

    const matrix = windows.find((w) => w.label === 'matrix')!;
    const admin = windows.find((w) => w.label === 'platform-admin-user')!;
    expect(matrix.startedAt < admin.endedAt && admin.startedAt < matrix.endedAt).toBe(true);

    // The admin identity is still wired into env exactly as before.
    expect(env.adminToken).toBe('admin-jwt');
    expect(env.capabilities.admin).toBe(true);
    expect(world.principals.accountId).toBe('a');
  });
});
