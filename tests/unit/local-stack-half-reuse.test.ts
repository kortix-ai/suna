import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_GATEWAY_INTERNAL_TOKEN } from '../src/core/local-profile';
import { ensureLocalStack, localTopology } from '../src/core/local-stack';

const supabase = {
  API_URL: 'http://127.0.0.1:54321',
  DB_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  ANON_KEY: 'anon',
  SERVICE_ROLE_KEY: 'service-role',
  JWT_SECRET: 'jwt-secret',
};

interface SpawnRecord {
  cwd: string;
  env: Record<string, string>;
}

/**
 * Drives `ensureLocalStack` against a fake process boundary: `fetch` answers
 * the health probes, and each spawned "process" flips its health flag and
 * survives between calls exactly like a real local stack the runner reuses.
 */
function stackHarness() {
  const spawns: SpawnRecord[] = [];
  const up = { api: false, gateway: false };
  const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/v1/health')) {
      if (!up.api) throw new Error('connect ECONNREFUSED');
      return new Response('{}', { status: 200 });
    }
    if (url.endsWith('/metrics')) {
      // The profile proof the runner requires before it reuses an API.
      return new Response('metrics disabled', {
        status: 404,
        headers: { 'x-kortix-local-test-profile': '1' },
      });
    }
    if (url.endsWith('/health/live')) {
      if (!up.gateway) throw new Error('connect ECONNREFUSED');
      return new Response('{}', { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  const spawnStub = vi.fn(
    (_command: string[], options: { cwd: string; env: Record<string, string> }) => {
      spawns.push({ cwd: options.cwd, env: { ...options.env } });
      if (options.cwd.endsWith('apps/api')) {
        up.api = true;
      } else {
        up.gateway = true;
      }
      return { exitCode: null, exited: Promise.resolve(0) };
    },
  );
  vi.stubGlobal('fetch', fetchStub);
  vi.stubGlobal('Bun', { spawn: spawnStub, sleep: () => Promise.resolve() });
  // The LATEST spawn of each half: a respawned half is the one whose token
  // must match the surviving half's env.
  const apiSpawn = () => spawns.filter((spawn) => spawn.cwd.endsWith('apps/api')).at(-1);
  const gatewaySpawn = () =>
    spawns.filter((spawn) => spawn.cwd.endsWith('apps/llm-gateway')).at(-1);
  return {
    spawns,
    up,
    apiSpawn,
    gatewaySpawn,
    run: () =>
      ensureLocalStack(localTopology('/repo', null), {
        autoStart: true,
        supabase,
      }),
  };
}

describe('ensureLocalStack gateway internal token', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts both halves on one shared token', async () => {
    const harness = stackHarness();
    await harness.run();
    expect(harness.apiSpawn()?.env.GATEWAY_INTERNAL_TOKEN).toBe(
      harness.gatewaySpawn()?.env.GATEWAY_INTERNAL_TOKEN,
    );
  });

  // The regression this guards: `ensureLocalStack` minted a fresh token on
  // every call while the API and gateway halves are reused independently. On a
  // half-reuse — the common re-run path while a local stack is alive — the
  // fresh half held a token the surviving half's env never carried, so every
  // gateway-to-API internal POST (/internal/gateway/authorize,
  // /authenticate) answered 401 and all gateway-proxied LLM traffic broke.
  it('reuses a surviving API with a respawned gateway on the same token', async () => {
    const harness = stackHarness();
    await harness.run();
    const startedApiToken = harness.apiSpawn()?.env.GATEWAY_INTERNAL_TOKEN;

    harness.up.gateway = false; // the gateway from the first run died
    await harness.run();

    expect(harness.gatewaySpawn()?.env.GATEWAY_INTERNAL_TOKEN).toBe(startedApiToken);
  });

  it('reuses a surviving gateway with a respawned API on the same token', async () => {
    const harness = stackHarness();
    await harness.run();
    harness.up.gateway = false; // the gateway from the first run died
    await harness.run();
    const survivingGatewayToken = harness.gatewaySpawn()?.env.GATEWAY_INTERNAL_TOKEN;

    harness.up.api = false; // the API from the second run died
    await harness.run();

    expect(harness.apiSpawn()?.env.GATEWAY_INTERNAL_TOKEN).toBe(survivingGatewayToken);
  });

  it('pins the fixed local profile token, not a per-call random mint', async () => {
    const harness = stackHarness();
    await harness.run();
    expect(harness.apiSpawn()?.env.GATEWAY_INTERNAL_TOKEN).toBe(LOCAL_GATEWAY_INTERNAL_TOKEN);
    expect(harness.gatewaySpawn()?.env.GATEWAY_INTERNAL_TOKEN).toBe(LOCAL_GATEWAY_INTERNAL_TOKEN);
    expect(harness.gatewaySpawn()?.env.GATEWAY_API_TOKEN).toBe(LOCAL_GATEWAY_INTERNAL_TOKEN);
  });
});
