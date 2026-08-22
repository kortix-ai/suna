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

  it('requires both deployed services to report the exact release SHA', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'ok', environment: 'staging', commit: SHA }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'healthy', commit: SHA }), {
          status: 200,
        }),
      );

    await expect(
      assertTargetSmokeHealth(
        {
          apiUrl: 'https://staging-api.kortix.com/v1',
          webUrl: 'https://staging.kortix.com',
          gatewayUrl: 'https://gateway-staging.kortix.com',
          expectedSha: SHA,
          environment: 'staging',
        },
        fetchImpl,
      ),
    ).resolves.toBeUndefined();
  });

  it('fails when staging serves another SHA', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ status: 'ok', environment: 'staging', commit: 'b'.repeat(40) }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'healthy', commit: SHA }), {
          status: 200,
        }),
      );

    await expect(
      assertTargetSmokeHealth(
        {
          apiUrl: 'https://staging-api.kortix.com/v1',
          webUrl: 'https://staging.kortix.com',
          gatewayUrl: 'https://gateway-staging.kortix.com',
          expectedSha: SHA,
          environment: 'staging',
        },
        fetchImpl,
      ),
    ).rejects.toThrow('staging SHA mismatch');
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
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'ok', environment: 'staging', commit: SHA }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(trafficDegradedGateway), { status: 200 }),
      );

    await expect(assertTargetSmokeHealth(STAGING, fetchImpl)).resolves.toBeUndefined();
  });

  it('still fails the smoke when the gateway cannot reach the API', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'ok', environment: 'staging', commit: SHA }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'degraded',
            commit: SHA,
            incidents: ['kortix api unreachable (http 502)'],
            checks: { api: { status: 'down' } },
          }),
          { status: 200 },
        ),
      );

    await expect(assertTargetSmokeHealth(STAGING, fetchImpl)).rejects.toThrow(
      'cannot reach the API',
    );
  });

  it('requires preview health to report preview and the exact SHA', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'ok', environment: 'preview', commit: SHA }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'healthy', commit: SHA }), { status: 200 }),
      );

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
