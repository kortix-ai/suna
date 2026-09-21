import { describe, expect, it, vi } from 'vitest';
import {
  assertGatewayPreflightHealth,
  assertTargetSmokeHealth,
  resolveTargetSmokeConfig,
} from '../src/core/target-smoke';

const SHA = 'a'.repeat(40);

const STAGING = {
  apiUrl: 'https://staging-api.kortix.com/v1',
  webUrl: 'https://staging.kortix.com',
  gatewayUrl: 'https://gateway-staging.kortix.com',
  expectedSha: SHA,
  environment: 'staging',
} as const;

/** The exact payload staging served on run 32240074477 attempt 1. */
const trafficDegradedGateway = {
  status: 'degraded',
  commit: SHA,
  incidents: ['error rate 100% over 300s'],
  checks: {
    api: { status: 'up', latency_ms: 41 },
    upstreams: { status: 'ok', tracked: 6, open: [] },
  },
  traffic: { requests: 12, error_rate: 1, window_s: 300 },
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

const okApi = (commit = SHA) => json({ status: 'ok', environment: 'staging', commit });
const okGateway = (commit = SHA) => json({ status: 'healthy', commit });
const okFrontend = (commit: string | undefined = SHA) =>
  json({ status: 'ok', service: 'web', version: '0.13.25-staging.8a1e38dc', commit });

/**
 * Route the mock by URL instead of by call order.
 *
 * The preflight reads three surfaces inside one `Promise.all`, so a
 * `mockResolvedValueOnce` chain binds each payload to whichever position the
 * implementation happens to fetch in — and silently hands `undefined` to any
 * read the chain is one short of. Routing by URL states which surface each
 * payload belongs to and survives a reordering of the three reads.
 */
function routedFetch(routes: {
  api?: () => Response;
  gateway?: () => Response;
  frontend?: () => Response;
}): typeof fetch {
  return vi.fn<typeof fetch>(async (input) => {
    const url = typeof input === 'string' ? input : String(input);
    const route = url.includes('/api/health')
      ? routes.frontend
      : url.includes('gateway')
        ? routes.gateway
        : routes.api;
    if (!route) throw new Error(`test mock has no response for ${url}`);
    return route();
  }) as unknown as typeof fetch;
}

describe('deployed staging smoke', () => {
  it('accepts only the exact staging API, web, gateway, and source SHA', () => {
    expect(
      resolveTargetSmokeConfig({
        KE2E_API_URL: 'https://staging-api.kortix.com/v1/',
        E2E_BASE_URL: 'https://staging.kortix.com/',
        KE2E_GATEWAY_URL: 'https://gateway-staging.kortix.com/',
        KE2E_EXPECT_SHA: SHA,
      }),
    ).toEqual({
      apiUrl: 'https://staging-api.kortix.com/v1',
      webUrl: 'https://staging.kortix.com',
      gatewayUrl: 'https://gateway-staging.kortix.com',
      expectedSha: SHA,
      environment: 'staging',
    });
  });

  it.each([
    ['production API', { KE2E_API_URL: 'https://api.kortix.com/v1' }],
    ['development API', { KE2E_API_URL: 'https://dev-api.kortix.com/v1' }],
    ['production web', { E2E_BASE_URL: 'https://kortix.com' }],
    ['development gateway', { KE2E_GATEWAY_URL: 'https://gateway-dev.kortix.com' }],
  ])('rejects the %s target', (_name, override) => {
    expect(() =>
      resolveTargetSmokeConfig({
        KE2E_API_URL: 'https://staging-api.kortix.com/v1',
        E2E_BASE_URL: 'https://staging.kortix.com',
        KE2E_GATEWAY_URL: 'https://gateway-staging.kortix.com',
        KE2E_EXPECT_SHA: SHA,
        ...override,
      }),
    ).toThrow('target smoke requires');
  });

  it('rejects a missing source SHA', () => {
    expect(() =>
      resolveTargetSmokeConfig({
        KE2E_API_URL: 'https://staging-api.kortix.com/v1',
        E2E_BASE_URL: 'https://staging.kortix.com',
        KE2E_GATEWAY_URL: 'https://gateway-staging.kortix.com',
      }),
    ).toThrow('KE2E_EXPECT_SHA');
  });

  it('accepts one explicitly authorized preview origin', () => {
    const origin = 'https://preview-6337.sbx.platinum.dev';
    expect(
      resolveTargetSmokeConfig({
        KE2E_TARGET: 'preview',
        KE2E_PREVIEW_ORIGIN: origin,
        KE2E_PREVIEW_AUTHORIZATION: `approved:${SHA}`,
        KE2E_API_URL: `${origin}/v1`,
        E2E_BASE_URL: origin,
        KE2E_GATEWAY_URL: `${origin}/_gateway`,
        KE2E_SUPABASE_URL: origin,
        KE2E_EXPECT_SHA: SHA,
      }),
    ).toEqual({
      apiUrl: `${origin}/v1`,
      webUrl: origin,
      gatewayUrl: `${origin}/_gateway`,
      expectedSha: SHA,
      environment: 'preview',
    });
  });

  it.each([
    ['missing approval', { KE2E_PREVIEW_AUTHORIZATION: '' }],
    ['wrong approval SHA', { KE2E_PREVIEW_AUTHORIZATION: `approved:${'b'.repeat(40)}` }],
    ['different API origin', { KE2E_API_URL: 'https://other.example/v1' }],
    ['different Supabase origin', { KE2E_SUPABASE_URL: 'https://other.example' }],
    ['wrong gateway path', { KE2E_GATEWAY_URL: 'https://preview.example/gateway' }],
  ])('rejects an unauthorized preview target: %s', (_name, override) => {
    const origin = 'https://preview.example';
    expect(() =>
      resolveTargetSmokeConfig({
        KE2E_TARGET: 'preview',
        KE2E_PREVIEW_ORIGIN: origin,
        KE2E_PREVIEW_AUTHORIZATION: `approved:${SHA}`,
        KE2E_API_URL: `${origin}/v1`,
        E2E_BASE_URL: origin,
        KE2E_GATEWAY_URL: `${origin}/_gateway`,
        KE2E_SUPABASE_URL: origin,
        KE2E_EXPECT_SHA: SHA,
        ...override,
      }),
    ).toThrow('preview');
  });

  it('requires all three deployed surfaces to report the exact release SHA', async () => {
    const fetchImpl = routedFetch({
      api: () => okApi(),
      gateway: () => okGateway(),
      frontend: () => okFrontend(),
    });

    await expect(assertTargetSmokeHealth(STAGING, fetchImpl)).resolves.toBeUndefined();
  });

  it('fails when staging serves another SHA', async () => {
    const fetchImpl = routedFetch({
      api: () => okApi('b'.repeat(40)),
      gateway: () => okGateway(),
      frontend: () => okFrontend(),
    });

    await expect(assertTargetSmokeHealth(STAGING, fetchImpl)).rejects.toThrow(
      'staging SHA mismatch',
    );
  });

  /**
   * The defect this file exists to stop. On the v0.13.25 gate the Vercel
   * deployment for the release SHA was still INITIALIZING when the browser
   * shards started, so staging.kortix.com served the previous release's
   * frontend while api and gateway both reported the release SHA. A
   * two-surface assertion is blind to it.
   */
  it('fails when only the frontend is stale, and names all three surfaces', async () => {
    const stale = 'fa68c114d7a9fcffc34f40497f2980f392797a47';
    const fetchImpl = routedFetch({
      api: () => okApi(),
      gateway: () => okGateway(),
      frontend: () => okFrontend(stale),
    });

    const error = await assertTargetSmokeHealth(STAGING, fetchImpl).catch((cause: Error) => cause);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('staging SHA mismatch');
    // A human must be able to read WHICH surface is behind and by what, without
    // opening the run. All three actual values plus the expectation.
    expect(message).toContain(`expected=${SHA}`);
    expect(message).toContain(`api=${SHA}`);
    expect(message).toContain(`gateway=${SHA}`);
    expect(message).toContain(`frontend=${stale}`);
  });

  it.each([
    // `next.config.ts` resolves the literal 'unknown' when neither
    // NEXT_PUBLIC_KORTIX_COMMIT nor VERCEL_GIT_COMMIT_SHA reached the build.
    ['the literal unknown', { status: 'ok', service: 'web', commit: 'unknown' }],
    // An older frontend, or one whose health route lost the field, sends no
    // `commit` key at all. Same verdict: nothing to compare.
    ['no commit field at all', { status: 'ok', service: 'web' }],
  ])(
    'reports an unstamped frontend commit (%s) as a build defect, not a mismatch',
    async (_name, body) => {
      const fetchImpl = routedFetch({
        api: () => okApi(),
        gateway: () => okGateway(),
        frontend: () => json(body),
      });

      const error = await assertTargetSmokeHealth(STAGING, fetchImpl).catch(
        (cause: Error) => cause,
      );

      const message = (error as Error).message;
      expect(message).toContain('did not stamp a commit');
      expect(message).toContain('NEXT_PUBLIC_KORTIX_COMMIT');
      expect(message).toContain('broken frontend BUILD, not a stale deploy');
      // Must NOT be laundered into the stale-deploy wording.
      expect(message).not.toContain('SHA mismatch');
    },
  );

  it('reports Vercel deployment protection instead of failing on an HTML login page', async () => {
    const fetchImpl = routedFetch({
      api: () => okApi(),
      gateway: () => okGateway(),
      frontend: () =>
        new Response('Redirecting...', {
          status: 302,
          headers: { location: 'https://vercel.com/sso-api?url=https%3A%2F%2Fstaging.kortix.com' },
        }),
    });

    await expect(assertTargetSmokeHealth(STAGING, fetchImpl)).rejects.toThrow(
      'Vercel deployment protection blocked the read',
    );
  });

  it('fails when the frontend health route does not answer its own contract', async () => {
    const fetchImpl = routedFetch({
      api: () => okApi(),
      gateway: () => okGateway(),
      frontend: () => json({ status: 'ok', service: 'not-web', commit: SHA }),
    });

    await expect(assertTargetSmokeHealth(STAGING, fetchImpl)).rejects.toThrow(
      'staging frontend health contract failed',
    );
  });

  it('accepts a gateway that reports healthy', () => {
    const logWarn = vi.fn();
    expect(() =>
      assertGatewayPreflightHealth({ status: 'healthy', commit: SHA }, logWarn),
    ).not.toThrow();
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('starts on a traffic-degraded gateway whose API check is up, and logs why', () => {
    // Run 32240074477 attempt 1: EVERY release-gate shard died in preflight
    // because the gateway's own rolling error-rate metric was spiking on traffic
    // from zombie test sessions. `checks.api.status` was 'up' the whole time.
    const logWarn = vi.fn();
    expect(() => assertGatewayPreflightHealth(trafficDegradedGateway, logWarn)).not.toThrow();
    expect(logWarn).toHaveBeenCalledTimes(1);
    const line = logWarn.mock.calls[0]?.[0] ?? '';
    expect(line).toContain('error rate 100% over 300s');
    expect(line).toContain('"error_rate":1');
  });

  it('starts when only an upstream circuit breaker is open', () => {
    const logWarn = vi.fn();
    expect(() =>
      assertGatewayPreflightHealth(
        {
          status: 'degraded',
          commit: SHA,
          incidents: ['upstream circuit open: bedrock'],
          checks: { api: { status: 'up' }, upstreams: { status: 'degraded', open: ['bedrock'] } },
        },
        logWarn,
      ),
    ).not.toThrow();
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'degraded with the API down',
      {
        status: 'degraded',
        incidents: ['kortix api unreachable (http 502)'],
        checks: { api: { status: 'down', error: 'http 502' } },
      },
      'cannot reach the API',
    ],
    [
      'degraded without any API verdict',
      { status: 'degraded', incidents: ['error rate 100% over 300s'] },
      'degraded without a checks.api verdict',
    ],
    [
      'unhealthy',
      { status: 'unhealthy', checks: { api: { status: 'down' } } },
      'gateway health contract failed',
    ],
    ['no status at all', {}, 'gateway health contract failed'],
    [
      'upstreams hard down',
      { status: 'degraded', checks: { api: { status: 'up' }, upstreams: { status: 'down' } } },
      'upstreams are down',
    ],
  ])('refuses to start on a gateway that is %s', (_name, gateway, message) => {
    expect(() => assertGatewayPreflightHealth(gateway, vi.fn())).toThrow(message);
  });

  it('runs the full smoke against a traffic-degraded staging gateway', async () => {
    const fetchImpl = routedFetch({
      api: () => okApi(),
      gateway: () => json(trafficDegradedGateway),
      frontend: () => okFrontend(),
    });

    await expect(assertTargetSmokeHealth(STAGING, fetchImpl)).resolves.toBeUndefined();
  });

  it('still fails the smoke when the gateway cannot reach the API', async () => {
    const fetchImpl = routedFetch({
      api: () => okApi(),
      gateway: () =>
        json({
          status: 'degraded',
          commit: SHA,
          incidents: ['kortix api unreachable (http 502)'],
          checks: { api: { status: 'down' } },
        }),
      frontend: () => okFrontend(),
    });

    await expect(assertTargetSmokeHealth(STAGING, fetchImpl)).rejects.toThrow(
      'cannot reach the API',
    );
  });

  it('requires preview health to report preview and the exact SHA on all three surfaces', async () => {
    // The preview stack is single-origin, so the three health paths differ only
    // by prefix: /v1/health, /_gateway/health, /api/health.
    const fetchImpl = routedFetch({
      api: () => json({ status: 'ok', environment: 'preview', commit: SHA }),
      gateway: () => json({ status: 'healthy', commit: SHA }),
      frontend: () => json({ status: 'ok', service: 'web', commit: SHA }),
    });

    await expect(
      assertTargetSmokeHealth(
        {
          apiUrl: 'https://preview.example/v1',
          webUrl: 'https://preview.example',
          gatewayUrl: 'https://preview.example/_gateway',
          expectedSha: SHA,
          environment: 'preview',
        },
        fetchImpl,
      ),
    ).resolves.toBeUndefined();
  });
});
